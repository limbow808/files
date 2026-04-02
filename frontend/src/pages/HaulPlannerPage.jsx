import { memo, useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useGlobalTick } from '../hooks/useGlobalTick';
import CargoTimelinePanel from '../components/CargoTimelinePanel';
import { LoadingState } from '../components/ui';
import { fmtISK, fmtVol } from '../utils/fmt';
import { API } from '../App';
import { DEFAULT_APP_SETTINGS, facilityToPlannerStructureType } from '../utils/appSettings';

const HAUL_JOB_ACTIONS = new Set(['manufacture', 'invent_first', 'copy_then_invent']);
const INVENTION_JOB_ACTIONS = new Set(['invent_first', 'copy_then_invent']);

function coerceNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundMoney(value) {
  return Math.round(coerceNumber(value) * 100) / 100;
}

function roundUnitVolume(value) {
  return Math.round(coerceNumber(value) * 10000) / 10000;
}

function normalizeRequirementQuantity(value) {
  const numeric = coerceNumber(value);
  if (Math.abs(numeric) < 1e-9) return 0;
  const roundedInt = Math.round(numeric);
  if (Math.abs(numeric - roundedInt) < 1e-6) return roundedInt;
  return Math.round(numeric * 100) / 100;
}

function formatCubicMeters(value) {
  if (!value || Number(value) <= 0) return '0 m3';
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(Number(value))} m3`;
}

function formatQueueWindow(startAt, nowTs) {
  const ts = Math.floor(coerceNumber(startAt));
  if (!ts) return 'NOW';
  const delta = ts - nowTs;
  if (delta <= 30) return 'NOW';
  if (delta < 3600) return `+${Math.max(1, Math.round(delta / 60))}M`;
  if (delta < 86400) return `+${(delta / 3600).toFixed(delta < 14400 ? 1 : 0)}H`;
  return `+${(delta / 86400).toFixed(1)}D`;
}

function isFutureQueuedJob(item, nowTs) {
  return coerceNumber(item?.start_at) > nowTs + 30;
}

function queueLabelForActions(actionKinds) {
  const hasManufacturing = actionKinds.has('manufacture');
  const hasInvention = Array.from(actionKinds).some((actionType) => INVENTION_JOB_ACTIONS.has(actionType));
  if (hasManufacturing && hasInvention) return 'MFG + INVENT';
  if (hasManufacturing) return 'MFG';
  if (hasInvention) return 'INVENT';
  return 'QUEUE';
}

function queueToneForActions(actionKinds) {
  const hasManufacturing = actionKinds.has('manufacture');
  const hasInvention = Array.from(actionKinds).some((actionType) => INVENTION_JOB_ACTIONS.has(actionType));
  if (hasManufacturing && hasInvention) return '#ffd36b';
  if (hasManufacturing) return '#ff9d3d';
  if (hasInvention) return '#4da6ff';
  return 'var(--text)';
}

function buildCopyMultibuyText(rows, mode) {
  return rows
    .map((row) => {
      const quantity = Math.max(0, Math.ceil(Number(mode === 'delta' ? row.delta_qty : row.required_qty) || 0));
      if (!quantity) return null;
      return `${row.name} ${quantity}`;
    })
    .filter(Boolean)
    .join('\n');
}

function collectInboundMaterialRows(materials, aggregate, consumerToken, allowedGroups = null) {
  (materials || []).forEach((material) => {
    if (!material || typeof material !== 'object') return;

    const children = Array.isArray(material.children) ? material.children : [];
    if (String(material.source || '').trim().toLowerCase() === 'craft' && children.length) {
      collectInboundMaterialRows(children, aggregate, consumerToken, allowedGroups);
      return;
    }

    const materialGroup = String(material.group || 'manufacturing').trim().toLowerCase();
    if (allowedGroups && !allowedGroups.has(materialGroup)) return;

    const typeId = Math.trunc(coerceNumber(material.type_id));
    if (typeId <= 0) return;

    let requiredQty = coerceNumber(material.needed_qty_total);
    if (requiredQty <= 0) requiredQty = coerceNumber(material.quantity);
    if (requiredQty <= 0) return;

    let totalRequiredCost = coerceNumber(material.total_line_cost);
    if (totalRequiredCost <= 0) {
      const fallbackLineCost = coerceNumber(material.line_cost);
      const baseQty = coerceNumber(material.quantity);
      if (fallbackLineCost > 0 && baseQty > 0) {
        totalRequiredCost = fallbackLineCost * (requiredQty / baseQty);
      }
    }

    let unitPrice = coerceNumber(material.unit_price);
    if (unitPrice <= 0 && requiredQty > 0 && totalRequiredCost > 0) {
      unitPrice = totalRequiredCost / requiredQty;
    }

    const unitVolumeM3 = coerceNumber(material.volume_m3);
    const row = aggregate.get(typeId) || {
      type_id: typeId,
      name: material.name || `Type ${typeId}`,
      required_qty: 0,
      total_required_cost: 0,
      unit_price: 0,
      unit_volume_m3: 0,
      groups: new Set(),
      consumers: new Set(),
    };

    row.required_qty += requiredQty;
    row.total_required_cost += totalRequiredCost > 0 ? totalRequiredCost : unitPrice * requiredQty;
    row.unit_price = unitPrice > 0 ? unitPrice : row.unit_price;
    row.unit_volume_m3 = Math.max(coerceNumber(row.unit_volume_m3), unitVolumeM3);
    row.groups.add(materialGroup);
    if (consumerToken) row.consumers.add(String(consumerToken));
    aggregate.set(typeId, row);
  });
}

function mergeFlatMaterialRows(rows) {
  const aggregate = new Map();

  rows.forEach((row) => {
    const typeId = Math.trunc(coerceNumber(row.type_id));
    if (typeId <= 0) return;

    const merged = aggregate.get(typeId) || {
      type_id: typeId,
      name: row.name || `Type ${typeId}`,
      required_qty: 0,
      available_qty: 0,
      delta_qty: 0,
      total_required_cost: 0,
      delta_cost: 0,
      unit_volume_m3: 0,
      required_volume_m3: 0,
      delta_volume_m3: 0,
      groups: new Set(),
    };

    merged.required_qty += coerceNumber(row.required_qty);
    merged.available_qty += coerceNumber(row.available_qty);
    merged.delta_qty += coerceNumber(row.delta_qty);
    merged.total_required_cost += coerceNumber(row.total_required_cost);
    merged.delta_cost += coerceNumber(row.delta_cost);
    merged.unit_volume_m3 = Math.max(coerceNumber(merged.unit_volume_m3), coerceNumber(row.unit_volume_m3));
    merged.required_volume_m3 += coerceNumber(row.required_volume_m3);
    merged.delta_volume_m3 += coerceNumber(row.delta_volume_m3);
    (row.groups || []).forEach((group) => merged.groups.add(String(group).toUpperCase()));

    aggregate.set(typeId, merged);
  });

  return Array.from(aggregate.values())
    .map((row) => ({
      type_id: row.type_id,
      name: row.name,
      groups: Array.from(row.groups).sort(),
      required_qty: normalizeRequirementQuantity(row.required_qty),
      available_qty: normalizeRequirementQuantity(Math.min(row.required_qty, row.available_qty)),
      delta_qty: normalizeRequirementQuantity(Math.max(0, row.delta_qty)),
      stocked: coerceNumber(row.delta_qty) <= 0,
      total_required_cost: roundMoney(row.total_required_cost),
      delta_cost: roundMoney(row.delta_cost),
      unit_volume_m3: roundUnitVolume(row.unit_volume_m3),
      required_volume_m3: roundMoney(row.required_volume_m3),
      delta_volume_m3: roundMoney(row.delta_volume_m3),
    }))
    .sort((left, right) => (
      Number(left.delta_qty > 0) !== Number(right.delta_qty > 0)
        ? Number(right.delta_qty > 0) - Number(left.delta_qty > 0)
        : coerceNumber(right.delta_cost) !== coerceNumber(left.delta_cost)
          ? coerceNumber(right.delta_cost) - coerceNumber(left.delta_cost)
          : coerceNumber(right.total_required_cost) - coerceNumber(left.total_required_cost)
    ) || String(left.name || '').localeCompare(String(right.name || '')));
}

function buildGroupedHaulData(plannerItems, inboundRows, options) {
  const { showInventionJobs, showFutureJobs, nowTs } = options;
  const remainingAvailability = new Map();
  const groups = [];
  const groupsByKey = new Map();
  const visibleJobs = [];
  let inventionJobCount = 0;
  let futureJobCount = 0;

  (inboundRows || []).forEach((row) => {
    const typeId = Math.trunc(coerceNumber(row.type_id));
    if (typeId <= 0) return;
    remainingAvailability.set(typeId, coerceNumber(row.available_qty));
  });

  (plannerItems || []).forEach((item, itemIndex) => {
    if (item?.is_idle) return;

    const actionType = String(item?.action_type || '').trim().toLowerCase();
    if (!HAUL_JOB_ACTIONS.has(actionType)) return;

    const inventionJob = INVENTION_JOB_ACTIONS.has(actionType);
    const futureJob = isFutureQueuedJob(item, nowTs);
    if (!showInventionJobs && inventionJob) return;
    if (!showFutureJobs && futureJob) return;

    const sourceMaterials = actionType === 'manufacture'
      ? ((Array.isArray(item.resolved_material_breakdown) && item.resolved_material_breakdown.length)
        ? item.resolved_material_breakdown
        : item.material_breakdown)
      : item.material_breakdown;
    const allowedGroups = inventionJob ? new Set(['datacore']) : null;
    const itemMaterials = new Map();

    collectInboundMaterialRows(
      sourceMaterials || [],
      itemMaterials,
      String(item.rec_id || `${actionType}:${itemIndex}`),
      allowedGroups,
    );

    if (!itemMaterials.size) return;

    visibleJobs.push(item);
    if (inventionJob) inventionJobCount += 1;
    if (futureJob) futureJobCount += 1;

    const outputId = Math.trunc(coerceNumber(item.output_id));
    const groupKey = outputId > 0 ? `type:${outputId}` : `name:${String(item.name || item.rec_id || itemIndex)}`;
    const group = groupsByKey.get(groupKey) || {
      key: groupKey,
      type_id: outputId,
      name: String(item.name || `Type ${outputId || itemIndex}`),
      actionKinds: new Set(),
      characterNames: new Set(),
      materialsMap: new Map(),
      jobCount: 0,
      inventionJobCount: 0,
      futureJobCount: 0,
      totalOutputQty: 0,
      earliestStartAt: 0,
      latestStartAt: 0,
    };

    if (!groupsByKey.has(groupKey)) {
      groupsByKey.set(groupKey, group);
      groups.push(group);
    }

    group.actionKinds.add(actionType);
    group.jobCount += 1;
    if (inventionJob) group.inventionJobCount += 1;
    if (futureJob) group.futureJobCount += 1;

    [item.assigned_character, item.copy_character, item.invent_character]
      .filter(Boolean)
      .forEach((character) => {
        const name = String(character?.character_name || '').trim();
        if (name) group.characterNames.add(name);
      });

    const startAt = Math.floor(coerceNumber(item.start_at));
    if (startAt > 0) {
      group.earliestStartAt = group.earliestStartAt > 0 ? Math.min(group.earliestStartAt, startAt) : startAt;
      group.latestStartAt = Math.max(group.latestStartAt, startAt);
    }

    let outputQty = coerceNumber(item.total_output_qty);
    if (outputQty <= 0) outputQty = coerceNumber(item.output_qty);
    if (outputQty <= 0) outputQty = coerceNumber(item.rec_runs);
    group.totalOutputQty += outputQty;

    Array.from(itemMaterials.values()).forEach((material) => {
      const typeId = Math.trunc(coerceNumber(material.type_id));
      if (typeId <= 0) return;

      const requiredQty = coerceNumber(material.required_qty);
      if (requiredQty <= 0) return;

      const unitPrice = coerceNumber(material.unit_price);
      const totalRequiredCost = coerceNumber(material.total_required_cost) > 0
        ? coerceNumber(material.total_required_cost)
        : unitPrice * requiredQty;
      const unitVolumeM3 = coerceNumber(material.unit_volume_m3);
      const availablePool = Math.max(0, coerceNumber(remainingAvailability.get(typeId)));
      const coveredQty = Math.min(requiredQty, availablePool);
      const deltaQty = Math.max(0, requiredQty - coveredQty);

      remainingAvailability.set(typeId, Math.max(0, availablePool - coveredQty));

      const row = group.materialsMap.get(typeId) || {
        type_id: typeId,
        name: material.name || `Type ${typeId}`,
        required_qty: 0,
        available_qty: 0,
        delta_qty: 0,
        total_required_cost: 0,
        delta_cost: 0,
        unit_price: 0,
        unit_volume_m3: 0,
        required_volume_m3: 0,
        delta_volume_m3: 0,
        groups: new Set(),
        consumers: new Set(),
      };

      row.required_qty += requiredQty;
      row.available_qty += coveredQty;
      row.delta_qty += deltaQty;
      row.total_required_cost += totalRequiredCost;
      row.delta_cost += unitPrice * deltaQty;
      row.unit_price = unitPrice > 0 ? unitPrice : row.unit_price;
      row.unit_volume_m3 = Math.max(coerceNumber(row.unit_volume_m3), unitVolumeM3);
      row.required_volume_m3 += unitVolumeM3 * requiredQty;
      row.delta_volume_m3 += unitVolumeM3 * deltaQty;
      material.groups.forEach((materialGroup) => row.groups.add(String(materialGroup).toUpperCase()));
      material.consumers.forEach((consumer) => row.consumers.add(String(consumer)));

      group.materialsMap.set(typeId, row);
    });
  });

  const finalizedGroups = groups
    .map((group) => {
      const materials = Array.from(group.materialsMap.values())
        .map((row) => ({
          type_id: row.type_id,
          name: row.name,
          groups: Array.from(row.groups).sort(),
          consumer_count: row.consumers.size,
          required_qty: normalizeRequirementQuantity(row.required_qty),
          available_qty: normalizeRequirementQuantity(Math.min(row.required_qty, row.available_qty)),
          delta_qty: normalizeRequirementQuantity(Math.max(0, row.delta_qty)),
          stocked: coerceNumber(row.delta_qty) <= 0,
          unit_price: roundMoney(row.unit_price),
          total_required_cost: roundMoney(row.total_required_cost),
          delta_cost: roundMoney(row.delta_cost),
          unit_volume_m3: roundUnitVolume(row.unit_volume_m3),
          required_volume_m3: roundMoney(row.required_volume_m3),
          delta_volume_m3: roundMoney(row.delta_volume_m3),
        }))
        .sort((left, right) => (
          Number(left.delta_qty > 0) !== Number(right.delta_qty > 0)
            ? Number(right.delta_qty > 0) - Number(left.delta_qty > 0)
            : coerceNumber(right.delta_cost) !== coerceNumber(left.delta_cost)
              ? coerceNumber(right.delta_cost) - coerceNumber(left.delta_cost)
              : coerceNumber(right.total_required_cost) - coerceNumber(left.total_required_cost)
        ) || String(left.name || '').localeCompare(String(right.name || '')));

      const totalRequiredCost = materials.reduce((sum, row) => sum + coerceNumber(row.total_required_cost), 0);
      const totalDeltaCost = materials.reduce((sum, row) => sum + coerceNumber(row.delta_cost), 0);
      const totalRequiredM3 = materials.reduce((sum, row) => sum + coerceNumber(row.required_volume_m3), 0);
      const totalDeltaM3 = materials.reduce((sum, row) => sum + coerceNumber(row.delta_volume_m3), 0);
      const stockedMaterialCount = materials.filter((row) => row.stocked).length;

      return {
        key: group.key,
        type_id: group.type_id,
        name: group.name,
        actionKinds: new Set(group.actionKinds),
        characterNames: Array.from(group.characterNames).sort(),
        queueLabel: queueLabelForActions(group.actionKinds),
        queueTone: queueToneForActions(group.actionKinds),
        jobCount: group.jobCount,
        inventionJobCount: group.inventionJobCount,
        futureJobCount: group.futureJobCount,
        totalOutputQty: normalizeRequirementQuantity(group.totalOutputQty),
        earliestStartAt: group.earliestStartAt,
        latestStartAt: group.latestStartAt,
        totalRequiredCost: roundMoney(totalRequiredCost),
        totalDeltaCost: roundMoney(totalDeltaCost),
        totalRequiredM3: roundMoney(totalRequiredM3),
        totalDeltaM3: roundMoney(totalDeltaM3),
        stockedMaterialCount,
        materialLineCount: materials.length,
        materials,
      };
    })
    .sort((left, right) => (
      Number(left.totalDeltaCost > 0) !== Number(right.totalDeltaCost > 0)
        ? Number(right.totalDeltaCost > 0) - Number(left.totalDeltaCost > 0)
        : coerceNumber(right.totalDeltaCost) !== coerceNumber(left.totalDeltaCost)
          ? coerceNumber(right.totalDeltaCost) - coerceNumber(left.totalDeltaCost)
          : coerceNumber(right.totalRequiredCost) !== coerceNumber(left.totalRequiredCost)
            ? coerceNumber(right.totalRequiredCost) - coerceNumber(left.totalRequiredCost)
            : (coerceNumber(left.earliestStartAt) || Number.MAX_SAFE_INTEGER) - (coerceNumber(right.earliestStartAt) || Number.MAX_SAFE_INTEGER)
    ) || String(left.name || '').localeCompare(String(right.name || '')));

  const flattenedRows = mergeFlatMaterialRows(finalizedGroups.flatMap((group) => group.materials));

  return {
    groups: finalizedGroups,
    rows: flattenedRows,
    visibleJobs,
    summary: {
      group_count: finalizedGroups.length,
      row_count: flattenedRows.length,
      stocked_count: flattenedRows.filter((row) => row.stocked).length,
      missing_count: flattenedRows.filter((row) => coerceNumber(row.delta_qty) > 0).length,
      consumer_count: visibleJobs.length,
      invention_job_count: inventionJobCount,
      future_job_count: futureJobCount,
      total_required_cost: roundMoney(flattenedRows.reduce((sum, row) => sum + coerceNumber(row.total_required_cost), 0)),
      total_delta_cost: roundMoney(flattenedRows.reduce((sum, row) => sum + coerceNumber(row.delta_cost), 0)),
      total_required_m3: roundMoney(flattenedRows.reduce((sum, row) => sum + coerceNumber(row.required_volume_m3), 0)),
      total_delta_m3: roundMoney(flattenedRows.reduce((sum, row) => sum + coerceNumber(row.delta_volume_m3), 0)),
    },
  };
}

export default memo(function HaulPlannerPage({ appSettings = DEFAULT_APP_SETTINGS, onSaveSettings }) {
  const [copiedMode, setCopiedMode] = useState('');
  const [showInventionJobs, setShowInventionJobs] = useState(true);
  const [showFutureJobs, setShowFutureJobs] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [nowTs, setNowTs] = useState(() => Math.floor(Date.now() / 1000));
  const plannerStructureType = facilityToPlannerStructureType(appSettings?.facility);
  const operationsCorpId = String(appSettings?.operations_corp_id || '');
  const corpInputDivision = String(appSettings?.corp_input_division || '');
  const corpOutputDivision = String(appSettings?.corp_output_division || '');

  useGlobalTick(() => {
    const nextNowTs = Math.floor(Date.now() / 1000);
    setNowTs((current) => (current === nextNowTs ? current : nextNowTs));
  });

  const plannerQuery = useMemo(() => {
    const params = new URLSearchParams({
      cycle_duration_hours: appSettings?.cycle_duration_hours,
      structure_job_time_bonus_pct: appSettings?.structureJobTimeBonusPct ?? 0,
      min_profit_per_cycle: appSettings?.min_profit_per_cycle,
      include_below_threshold_items: appSettings?.include_below_threshold_items ? 'true' : 'false',
      max_sell_days_tolerance: appSettings?.max_sell_days_tolerance,
      target_isk_per_m3: appSettings?.target_isk_per_m3 ?? 0,
      weight_by_velocity: appSettings?.weight_by_velocity ? 'true' : 'false',
      count_corp_original_blueprints_as_own: appSettings?.count_corp_original_blueprints_as_own ? 'true' : 'false',
      system: appSettings?.system || 'Korsiki',
      facility: appSettings?.facility || 'large',
      structure_type: plannerStructureType || 'engineering_complex',
      rig_1: appSettings?.rig_1 || 'none',
      rig_2: appSettings?.rig_2 || 'none',
    });
    if (appSettings?.facilityTaxRate !== '') params.set('facility_tax_rate', String(parseFloat(appSettings.facilityTaxRate) / 100));
    if (appSettings?.rigBonusMfg !== '') params.set('rig_bonus_mfg', String(appSettings.rigBonusMfg));
    if (operationsCorpId) params.set('operations_corp_id', operationsCorpId);
    if (corpInputDivision) params.set('corp_input_division', corpInputDivision);
    if (corpOutputDivision) params.set('corp_output_division', corpOutputDivision);
    return `${API}/api/job-planner?${params.toString()}`;
  }, [appSettings, corpInputDivision, corpOutputDivision, operationsCorpId, plannerStructureType]);

  const { data: plannerData, loading, error, stale, refetch } = useApi(plannerQuery, [plannerQuery]);
  const {
    data: corpContext,
    loading: corpContextLoading,
    stale: corpContextStale,
    refetch: refetchCorpContext,
  } = useApi(`${API}/api/corp-context`, []);

  const plannerItems = plannerData?.items || [];
  const inboundRows = plannerData?.inbound_requirements?.rows || [];
  const plannerInventorySource = plannerData?.inventory_source || null;
  const plannerWalletSource = plannerData?.wallet_source || null;
  const corporations = corpContext?.corporations || [];
  const selectedCorp = corporations.find(corp => String(corp.corporation_id) === operationsCorpId) || null;
  const divisionOptions = selectedCorp?.available_divisions || [];
  const corpWarnings = corpContext?.warnings || [];
  const selectedOutputDivision = divisionOptions.find((division) => String(division.flag) === corpOutputDivision) || null;
  const plannerSourceCorpName = String(selectedCorp?.corporation_name || plannerInventorySource?.corporation_name || 'UNKNOWN CORP').toUpperCase();
  const plannerSourceDivision = String(
    plannerInventorySource?.division_label
    || plannerInventorySource?.division_flag
    || (corpInputDivision ? `Input ${corpInputDivision}` : 'Select Input Hangar'),
  ).toUpperCase();
  const outputSourceDivision = String(
    selectedOutputDivision?.label
    || selectedOutputDivision?.flag
    || (corpOutputDivision ? `Output ${corpOutputDivision}` : 'Select Output Hangar'),
  ).toUpperCase();

  const haulFilterCounts = useMemo(() => {
    let haulJobs = 0;
    let inventionJobs = 0;
    let futureJobs = 0;

    plannerItems.forEach((item) => {
      if (item?.is_idle) return;
      const actionType = String(item?.action_type || '').trim().toLowerCase();
      if (!HAUL_JOB_ACTIONS.has(actionType)) return;
      haulJobs += 1;
      if (INVENTION_JOB_ACTIONS.has(actionType)) inventionJobs += 1;
      if (isFutureQueuedJob(item, nowTs)) futureJobs += 1;
    });

    return { haulJobs, inventionJobs, futureJobs };
  }, [nowTs, plannerItems]);

  const haulData = useMemo(
    () => buildGroupedHaulData(plannerItems, inboundRows, { showInventionJobs, showFutureJobs, nowTs }),
    [inboundRows, nowTs, plannerItems, showFutureJobs, showInventionJobs],
  );
  const haulGroups = haulData.groups;
  const haulSummary = haulData.summary;
  const visibleHaulRows = haulData.rows;
  const visiblePlannerItems = haulData.visibleJobs;
  const plannerSciItems = useMemo(
    () => visiblePlannerItems.filter((item) => INVENTION_JOB_ACTIONS.has(String(item?.action_type || '').trim().toLowerCase())),
    [visiblePlannerItems],
  );
  const plannerMfgItems = useMemo(
    () => visiblePlannerItems.filter((item) => String(item?.action_type || '').trim().toLowerCase() === 'manufacture'),
    [visiblePlannerItems],
  );
  const deltaRows = useMemo(
    () => visibleHaulRows.filter((row) => Number(row.delta_qty || 0) > 0),
    [visibleHaulRows],
  );
  const allRows = useMemo(
    () => visibleHaulRows.filter((row) => Number(row.required_qty || 0) > 0),
    [visibleHaulRows],
  );

  function updateSettings(patch) {
    onSaveSettings?.({ ...appSettings, ...patch });
  }

  function toggleGroup(groupKey) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  async function handleCopy(mode) {
    const relevantRows = mode === 'delta' ? deltaRows : allRows;
    const text = buildCopyMultibuyText(relevantRows, mode);
    if (!text || !navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMode(mode);
      window.setTimeout(() => setCopiedMode(''), 1800);
    } catch {
      // Ignore clipboard failures; the page remains usable without OS clipboard access.
    }
  }

  return (
    <div className="calc-page" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="panel-hdr" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, letterSpacing: 2, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
          INBOUND HAUL REQUIREMENTS
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 10, color: stale ? 'var(--accent)' : 'var(--dim)', letterSpacing: 1 }}>
            {stale ? 'REFRESHING' : `${haulSummary.group_count || 0} ITEMS · ${haulSummary.consumer_count || 0} JOBS · ${haulSummary.row_count || 0} MAT TYPES`}
          </span>
          <button
            onClick={() => handleCopy('delta')}
            disabled={!deltaRows.length}
            style={{
              background: deltaRows.length ? '#4cff91' : 'rgba(255,255,255,0.08)',
              border: '1px solid var(--border)',
              color: deltaRows.length ? '#000' : 'var(--dim)',
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: 1,
              padding: '3px 10px',
              cursor: deltaRows.length ? 'pointer' : 'default',
              fontWeight: 700,
            }}
            title="Copy only what is still missing from the planner input hangar"
          >
            {copiedMode === 'delta' ? 'COPIED DELTA' : 'COPY DELTA'}
          </button>
          <button
            onClick={() => handleCopy('all')}
            disabled={!allRows.length}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              color: allRows.length ? 'var(--text)' : 'var(--dim)',
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: 1,
              padding: '3px 10px',
              cursor: allRows.length ? 'pointer' : 'default',
            }}
            title="Copy the full planner requirement list regardless of current stock"
          >
            {copiedMode === 'all' ? 'COPIED ALL' : 'COPY ALL'}
          </button>
          <button
            onClick={refetch}
            disabled={loading}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              color: 'var(--text)',
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: 1,
              padding: '3px 10px',
              cursor: loading ? 'default' : 'pointer',
            }}
          >
            {loading ? 'REFRESHING' : 'REFRESH'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 10, letterSpacing: 1, color: 'var(--dim)' }}>
          OPERATIONS CORP
          <select
            value={operationsCorpId}
            onChange={(event) => updateSettings({
              operations_corp_id: event.target.value,
              corp_input_division: '',
              corp_output_division: '',
            })}
            style={controlStyle}
          >
            <option value="">PERSONAL / LEGACY ASSETS</option>
            {corporations.map((corp) => (
              <option key={corp.corporation_id} value={corp.corporation_id}>
                {`${String(corp.corporation_name || '').toUpperCase()}${corp.operations_ready ? '' : ' · NO CORP ASSET ACCESS'}`}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 10, letterSpacing: 1, color: 'var(--dim)' }}>
          INPUT HANGAR
          <select
            value={corpInputDivision}
            disabled={!operationsCorpId}
            onChange={(event) => updateSettings({ corp_input_division: event.target.value })}
            style={controlStyle}
          >
            <option value="">{operationsCorpId ? 'SELECT INPUT HANGAR' : 'SELECT OPERATIONS CORP FIRST'}</option>
            {divisionOptions.map((division) => (
              <option key={division.flag} value={division.flag}>
                {`${String(division.label || division.flag).toUpperCase()} · ${division.item_count || 0} ITEMS`}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 10, letterSpacing: 1, color: 'var(--dim)' }}>
          OUTPUT HANGAR
          <select
            value={corpOutputDivision}
            disabled={!operationsCorpId}
            onChange={(event) => updateSettings({ corp_output_division: event.target.value })}
            style={controlStyle}
          >
            <option value="">{operationsCorpId ? 'SELECT OUTPUT HANGAR' : 'SELECT OPERATIONS CORP FIRST'}</option>
            {divisionOptions.map((division) => (
              <option key={division.flag} value={division.flag}>
                {`${String(division.label || division.flag).toUpperCase()} · ${division.item_count || 0} ITEMS`}
              </option>
            ))}
          </select>
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'flex-end' }}>
          <button
            onClick={refetchCorpContext}
            style={{ ...controlStyle, cursor: 'pointer', textAlign: 'center' }}
          >
            {corpContextLoading || corpContextStale ? 'REFRESHING CORP ACCESS' : 'REFRESH CORP ACCESS'}
          </button>
        </div>
      </div>

      <div style={{ padding: '8px 14px 10px', borderBottom: '1px solid var(--border)', background: 'rgba(255,157,61,0.05)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 10, letterSpacing: 1, color: 'var(--dim)' }}>
          {operationsCorpId
            ? `INBOUND TARGET · ${plannerSourceCorpName} · ${plannerSourceDivision}`
            : 'INBOUND TARGET · PERSONAL / LEGACY ASSET MODE'}
        </div>
        {operationsCorpId && (
          <div style={{ fontSize: 10, letterSpacing: 1, color: 'var(--dim)' }}>
            {`OUTPUT INVENTORY · ${outputSourceDivision}`}
          </div>
        )}
        {plannerInventorySource?.warning && (
          <div style={{ fontSize: 10, color: 'var(--accent)', letterSpacing: 0.4 }}>
            INPUT HANGAR WARNING: {plannerInventorySource.warning}
          </div>
        )}
        {plannerWalletSource?.warning && (
          <div style={{ fontSize: 10, color: 'var(--accent)', letterSpacing: 0.4 }}>
            WALLET WARNING: {plannerWalletSource.warning}
          </div>
        )}
        {corpWarnings.map((warning) => (
          <div key={warning} style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 0.4 }}>
            {warning}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '8px 14px 10px', borderBottom: '1px solid var(--border)', background: 'rgba(77,166,255,0.04)' }}>
        <FilterToggle
          label="INVENTION JOBS"
          detail={`${haulFilterCounts.inventionJobs} TOTAL`}
          active={showInventionJobs}
          tone="#4da6ff"
          onClick={() => setShowInventionJobs((current) => !current)}
        />
        <FilterToggle
          label="FUTURE QUEUED"
          detail={`${haulFilterCounts.futureJobs} TOTAL`}
          active={showFutureJobs}
          tone="#ffcf66"
          onClick={() => setShowFutureJobs((current) => !current)}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'linear-gradient(180deg, rgba(255,71,0,0.08), rgba(255,71,0,0))' }}>
        <MetricCard label="ITEM GROUPS" value={`${haulSummary.group_count || 0}`} tone="var(--text)" />
        <MetricCard label="VISIBLE JOBS" value={`${haulSummary.consumer_count || 0}`} tone="var(--text)" />
        <MetricCard label="TOTAL REQUIRED" value={fmtISK(haulSummary.total_required_cost)} tone="var(--accent)" />
        <MetricCard label="TO BUY" value={fmtISK(haulSummary.total_delta_cost)} tone="var(--green)" />
        <MetricCard label="TO HAUL" value={formatCubicMeters(haulSummary.total_delta_m3)} tone="#4da6ff" />
        <MetricCard label="READY LINES" value={`${haulSummary.stocked_count || 0}/${haulSummary.row_count || 0}`} tone="var(--text)" />
      </div>

      <CargoTimelinePanel
        cycleHours={appSettings?.cycle_duration_hours}
        mfgItems={plannerMfgItems}
        sciItems={plannerSciItems}
        haulCapacityM3={appSettings?.haul_capacity_m3}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {loading && !plannerData ? (
          <LoadingState label="BUILDING INBOUND HAUL LIST" sub="PLANNER JOBS · INPUT HANGAR · INVENTION" />
        ) : error ? (
          <div style={{ padding: '24px 16px', color: 'var(--error)', fontSize: 11, letterSpacing: 1 }}>
            INBOUND REQUIREMENTS UNAVAILABLE
          </div>
        ) : haulGroups.length === 0 ? (
          <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 1, textAlign: 'center' }}>
            {(inboundRows.length > 0 || haulFilterCounts.haulJobs > 0)
              ? 'NO HAUL ITEMS MATCH THE CURRENT FILTERS'
              : 'NO INBOUND MATERIALS ARE REQUIRED FOR THE CURRENT JOB PLANNER QUEUE'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr style={{ background: 'var(--table-row-bg)' }}>
                <th style={{ width: '33%', textAlign: 'left' }}>ITEM</th>
                <th style={{ width: '12%' }}>QUEUE</th>
                <th style={{ width: '7%' }}>JOBS</th>
                <th style={{ width: '8%' }}>OUTPUT</th>
                <th style={{ width: '7%' }}>MATS</th>
                <th style={{ width: '8%' }}>READY</th>
                <th style={{ width: '9%' }}>TO HAUL</th>
                <th style={{ width: '8%' }}>ALL MATS</th>
                <th style={{ width: '8%', paddingRight: 14 }}>DELTA COST</th>
              </tr>
            </thead>
            <tbody>
              {haulGroups.map((group, idx) => {
                const expanded = expandedGroups.has(group.key);
                const stocked = group.totalDeltaCost <= 0;
                const deltaTone = stocked ? '#4cff91' : 'var(--accent)';
                const characterLabel = group.characterNames.length > 0
                  ? group.characterNames.slice(0, 2).join(' · ').toUpperCase()
                  : null;

                return (
                  <HaulGroupRows
                    key={group.key}
                    delayMs={idx * 18}
                    group={group}
                    expanded={expanded}
                    stocked={stocked}
                    deltaTone={deltaTone}
                    characterLabel={characterLabel}
                    nowTs={nowTs}
                    onToggle={() => toggleGroup(group.key)}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
});

function MetricCard({ label, value, tone }) {
  return (
    <div style={{ border: '1px solid var(--border)', background: 'rgba(18,18,18,0.95)', padding: '10px 12px' }}>
      <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'var(--dim)', marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 18, letterSpacing: 0.5, color: tone }}>{value || '—'}</div>
    </div>
  );
}

function FilterToggle({ label, detail, active, onClick, tone }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 10px',
        border: '1px solid var(--border)',
        background: active ? tone : 'rgba(255,255,255,0.04)',
        color: active ? '#000' : 'var(--text)',
        fontFamily: 'var(--mono)',
        fontSize: 10,
        letterSpacing: 0.8,
        cursor: 'pointer',
      }}
    >
      <span style={{ fontWeight: 700 }}>{active ? 'ON' : 'OFF'}</span>
      <span>{label}</span>
      <span style={{ color: active ? 'rgba(0,0,0,0.72)' : 'var(--dim)' }}>{detail}</span>
    </button>
  );
}

function HaulGroupRows({ group, expanded, stocked, deltaTone, characterLabel, nowTs, onToggle, delayMs }) {
  return (
    <>
      <tr
        className="eve-row-reveal"
        style={{
          animationDelay: `${delayMs}ms`,
          background: expanded ? 'rgba(77,166,255,0.08)' : 'transparent',
        }}
      >
        <td style={{ padding: '8px 10px', textAlign: 'left' }}>
          <button
            type="button"
            onClick={onToggle}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              background: 'none',
              border: 'none',
              padding: 0,
              color: 'inherit',
              cursor: 'pointer',
              textAlign: 'left',
            }}
            title={expanded ? 'Hide material breakdown' : 'Show material breakdown'}
          >
            <span
              style={{
                width: 18,
                height: 18,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid rgba(255,255,255,0.12)',
                background: expanded ? 'rgba(77,166,255,0.16)' : 'rgba(255,255,255,0.04)',
                color: expanded ? '#4da6ff' : 'var(--dim)',
                flexShrink: 0,
                fontFamily: 'var(--mono)',
                fontSize: 10,
              }}
            >
              {expanded ? '-' : '+'}
            </span>
            {group.type_id > 0 && (
              <img
                src={`https://images.evetech.net/types/${group.type_id}/icon?size=32`}
                alt=""
                style={{ width: 22, height: 22, flexShrink: 0, opacity: 0.9 }}
                onError={(event) => { event.target.style.display = 'none'; }}
              />
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, letterSpacing: 0.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={group.name}>
                {group.name}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 3, fontSize: 9, color: 'var(--dim)', letterSpacing: 0.5, flexWrap: 'wrap' }}>
                <span>{`${group.jobCount} JOB${group.jobCount === 1 ? '' : 'S'}`}</span>
                <span>{`NEXT ${formatQueueWindow(group.earliestStartAt, nowTs)}`}</span>
                {characterLabel && <span title={group.characterNames.join(' · ')}>{characterLabel}</span>}
                {group.futureJobCount > 0 && <span style={{ color: '#4da6ff' }}>{`${group.futureJobCount} FUTURE`}</span>}
                {stocked && <span style={{ color: '#4cff91' }}>STOCKED</span>}
              </div>
            </div>
          </button>
        </td>
        <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: group.queueTone }}>{group.queueLabel}</td>
        <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{group.jobCount}</td>
        <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtVol(group.totalOutputQty)}</td>
        <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{group.materialLineCount}</td>
        <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: group.stockedMaterialCount === group.materialLineCount ? '#4cff91' : 'var(--text)' }}>
          {`${group.stockedMaterialCount}/${group.materialLineCount}`}
        </td>
        <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: group.totalDeltaM3 > 0 ? '#4da6ff' : 'var(--dim)' }}>
          {group.totalDeltaM3 > 0 ? formatCubicMeters(group.totalDeltaM3) : '—'}
        </td>
        <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)' }}>{fmtISK(group.totalRequiredCost)}</td>
        <td style={{ paddingRight: 14, fontFamily: 'var(--mono)', fontSize: 11, color: deltaTone }}>
          {stocked ? 'STOCKED' : fmtISK(group.totalDeltaCost)}
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: 'rgba(255,255,255,0.025)' }}>
          <td colSpan={9} style={{ padding: 0 }}>
            <div style={{ padding: '0 10px 12px 36px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
                    <th style={{ width: '31%', textAlign: 'left', padding: '7px 10px', fontSize: 10, letterSpacing: 0.8 }}>MATERIAL</th>
                    <th style={{ width: '11%', padding: '7px 6px', fontSize: 10, letterSpacing: 0.8 }}>TYPE</th>
                    <th style={{ width: '9%', padding: '7px 6px', fontSize: 10, letterSpacing: 0.8 }}>REQUIRED</th>
                    <th style={{ width: '10%', padding: '7px 6px', fontSize: 10, letterSpacing: 0.8 }}>COVERED</th>
                    <th style={{ width: '9%', padding: '7px 6px', fontSize: 10, letterSpacing: 0.8 }}>DELTA</th>
                    <th style={{ width: '10%', padding: '7px 6px', fontSize: 10, letterSpacing: 0.8 }}>DELTA M3</th>
                    <th style={{ width: '10%', padding: '7px 6px', fontSize: 10, letterSpacing: 0.8 }}>ALL MATS</th>
                    <th style={{ width: '10%', padding: '7px 14px 7px 6px', fontSize: 10, letterSpacing: 0.8 }}>DELTA COST</th>
                  </tr>
                </thead>
                <tbody>
                  {group.materials.map((material) => {
                    const typeLabel = (material.groups || []).join(' · ') || 'MATERIAL';
                    const materialStocked = Boolean(material.stocked);
                    const materialDeltaTone = materialStocked ? '#4cff91' : 'var(--accent)';
                    const deltaQty = coerceNumber(material.delta_qty);

                    return (
                      <tr key={`${group.key}:${material.type_id}`}>
                        <td style={{ padding: '7px 10px', textAlign: 'left' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                            <img
                              src={`https://images.evetech.net/types/${material.type_id}/icon?size=32`}
                              alt=""
                              style={{ width: 20, height: 20, flexShrink: 0, opacity: 0.82 }}
                              onError={(event) => { event.target.style.display = 'none'; }}
                            />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 11, letterSpacing: 0.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={material.name}>
                                {material.name}
                              </div>
                              <div style={{ display: 'flex', gap: 8, marginTop: 2, fontSize: 9, color: 'var(--dim)', letterSpacing: 0.4, flexWrap: 'wrap' }}>
                                <span>{`${material.consumer_count || 0} JOB${Number(material.consumer_count || 0) === 1 ? '' : 'S'}`}</span>
                                <span>{fmtISK(material.unit_price || 0)}/UNIT</span>
                                {materialStocked && <span style={{ color: '#4cff91' }}>STOCKED</span>}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: typeLabel.includes('DATACORE') ? '#4da6ff' : 'var(--text)' }}>
                          {typeLabel}
                        </td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtVol(material.required_qty)}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: coerceNumber(material.available_qty) > 0 ? '#4cff91' : 'var(--dim)' }}>
                          {fmtVol(material.available_qty)}
                        </td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: materialDeltaTone }}>
                          {materialStocked ? 'STOCKED' : fmtVol(material.delta_qty)}
                        </td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: deltaQty > 0 ? '#4da6ff' : 'var(--dim)' }}>
                          {deltaQty > 0 ? formatCubicMeters(material.delta_volume_m3) : '—'}
                        </td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)' }}>
                          {fmtISK(material.total_required_cost)}
                        </td>
                        <td style={{ paddingRight: 14, fontFamily: 'var(--mono)', fontSize: 11, color: materialDeltaTone }}>
                          {deltaQty > 0 ? fmtISK(material.delta_cost) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const controlStyle = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: 1,
  padding: '3px 8px',
  outline: 'none',
};
