import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import * as XLSX from 'xlsx'

// ─── Types ───────────────────────────────────────────────────────────────────

type AllocationMode = 'distance' | 'balanced' | 'capacity'
type AppView = 'operation' | 'analysis' | 'quality'
type RouteSource = 'osrm' | 'estimate'
type SortField = 'description' | 'baseName' | 'distanceKm' | 'durationMin'
type SortDir = 'asc' | 'desc'
type SourceFilter = 'all' | 'osrm' | 'estimate'
type TrafficScenario = 'free' | 'normal' | 'morning_peak' | 'evening_peak' | 'severe'
type TimeWindow = 'early' | 'morning' | 'business' | 'lunch' | 'afternoon' | 'evening' | 'night'

type MapLayers = {
  services: boolean
  bases: boolean
  outliers: boolean
  longServices: boolean
  saturatedBases: boolean
  heatmap: boolean
  regions: boolean
  changedServices: boolean
}

type ConnectionMode = 'off' | 'selected' | 'long' | 'all'
type HeatMetric = 'count' | 'distance' | 'time'

type ServiceRow = {
  id: number
  description: string
  lat: number
  lng: number
}

type BaseRow = {
  id: string
  name: string
  address: string
  lat: number
  lng: number
  capacity: number
}

type RouteValue = {
  distanceKm: number
  durationMin: number
  source: RouteSource
}

type Assignment = ServiceRow & {
  baseId: string
  baseName: string
  distanceKm: number
  durationMin: number
  source: RouteSource
}

type BaseSummary = BaseRow & {
  assigned: number
  totalKm: number
  totalMin: number
  avgKm: number
  avgMin: number
  saturation: number
}

type QualityIssue = {
  id: string
  serviceId?: number
  type: string
  severity: 'Alerta' | 'Crítico'
  description: string
  lat: number
  lng: number
  detail: string
  excludeByDefault?: boolean
}

type CompactRoutes = {
  v: 1
  sids: number[]
  bids: string[]
  d: (number | null)[][]
  t: (number | null)[][]
}

type RouteIndex = {
  sidMap: Map<number, number>
  bidMap: Map<string, number>
  d: (number | null)[][]
  t: (number | null)[][]
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DATA_BASE_URL = `${import.meta.env.BASE_URL}data/`
const SERVICES_FILE = `${DATA_BASE_URL}services.json`
const BASES_FILE = `${DATA_BASE_URL}bases.json`
const ROUTES_FILE = `${DATA_BASE_URL}osrm-routes.json`
const FALLBACK_AVG_SPEED = 34
const FALLBACK_ROAD_FACTOR = 1.28
const DF_BOUNDS = { minLat: -16.12, maxLat: -15.45, minLng: -48.30, maxLng: -47.25 }

const BASE_COLORS = [
  '#e74c3c', '#3498db', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#fd79a8', '#6c5ce7',
]

const TRAFFIC_SCENARIOS: Record<TrafficScenario, { label: string; factor: number; detail: string }> = {
  free: { label: 'Fluxo livre', factor: 0.9, detail: 'tempo OSRM -10%' },
  normal: { label: 'Tempo médio', factor: 1, detail: 'tempo OSRM original' },
  morning_peak: { label: 'Pico manhã', factor: 1.3, detail: 'tempo OSRM +30%' },
  evening_peak: { label: 'Pico tarde', factor: 1.45, detail: 'tempo OSRM +45%' },
  severe: { label: 'Trânsito severo', factor: 1.7, detail: 'tempo OSRM +70%' },
}

const TIME_WINDOWS: Record<TimeWindow, { label: string; factor: number; detail: string }> = {
  early: { label: '06h - antes do pico', factor: 0.95, detail: 'saída antecipada' },
  morning: { label: '07h-09h - pico manhã', factor: 1.25, detail: 'maior pressão de entrada' },
  business: { label: '09h-11h - comercial', factor: 1, detail: 'referência operacional' },
  lunch: { label: '11h-14h - almoço', factor: 1.08, detail: 'tráfego intermediário' },
  afternoon: { label: '14h-17h - tarde', factor: 1.05, detail: 'fluxo moderado' },
  evening: { label: '17h-19h - pico tarde', factor: 1.35, detail: 'maior pressão de retorno' },
  night: { label: '20h+ - noite', factor: 0.88, detail: 'menor fluxo viário' },
}

const DEFAULT_MAP_LAYERS: MapLayers = {
  services: true,
  bases: true,
  outliers: false,
  longServices: false,
  saturatedBases: false,
  heatmap: false,
  regions: false,
  changedServices: false,
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PlannerApp() {
  const [services, setServices] = useState<ServiceRow[]>([])
  const [bases, setBases] = useState<BaseRow[]>([])
  const [routeIndex, setRouteIndex] = useState<RouteIndex | null>(null)
  const [loading, setLoading] = useState(true)
  const [allocationMode, setAllocationMode] = useState<AllocationMode>('distance')
  const [trafficScenario, setTrafficScenario] = useState<TrafficScenario>('normal')
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('business')
  const [activeView, setActiveView] = useState<AppView>('operation')
  const [mapLayers, setMapLayers] = useState<MapLayers>(DEFAULT_MAP_LAYERS)
  const [mapDistanceLimit, setMapDistanceLimit] = useState(0)
  const [mapTimeLimit, setMapTimeLimit] = useState(0)
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('off')
  const [heatMetric, setHeatMetric] = useState<HeatMetric>('count')
  const [mapFullscreen, setMapFullscreen] = useState(false)
  const [search, setSearch] = useState('')
  const [baseFilter, setBaseFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [sortBy, setSortBy] = useState<SortField>('distanceKm')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [showOutliers, setShowOutliers] = useState(false)
  const [pinnedServices, setPinnedServices] = useState<Record<number, string>>({})
  const [showOnlyPinned, setShowOnlyPinned] = useState(false)
  const [status, setStatus] = useState('Carregando dados...')

  useEffect(() => { void loadData() }, [])

  // ─── Derived state ──────────────────────────────────────────────────────────

  const baseColorMap = useMemo(
    () => new Map(bases.map((base, i) => [base.id, BASE_COLORS[i % BASE_COLORS.length]])),
    [bases],
  )

  const trafficFactor = TRAFFIC_SCENARIOS[trafficScenario].factor * TIME_WINDOWS[timeWindow].factor

  const assignments = useMemo(
    () => assignServices(services, bases, routeIndex, allocationMode, pinnedServices, trafficFactor),
    [services, bases, routeIndex, allocationMode, pinnedServices, trafficFactor],
  )

  const summaries = useMemo(() => summarizeBases(bases, assignments), [bases, assignments])

  const qualityIssues = useMemo(
    () => auditCoordinateQuality(services, bases, routeIndex),
    [services, bases, routeIndex],
  )

  const outlierIds = useMemo(
    () => new Set(qualityIssues.filter((i) => i.excludeByDefault).map((i) => i.serviceId).filter(Boolean) as number[]),
    [qualityIssues],
  )

  const filteredAssignments = useMemo(() => {
    const query = normalizeText(search)
    const filtered = assignments.filter((item) => {
      if (showOnlyPinned && !pinnedServices[item.id]) return false
      const matchesText = !query || normalizeText(item.description).includes(query) || normalizeText(item.baseName).includes(query)
      const matchesBase = baseFilter === 'all' || item.baseId === baseFilter
      const matchesOutlier = showOutliers || !outlierIds.has(item.id)
      const matchesSource = sourceFilter === 'all' || item.source === sourceFilter
      return matchesText && matchesBase && matchesOutlier && matchesSource
    })
    return [...filtered].sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1
      if (sortBy === 'distanceKm') return (a.distanceKm - b.distanceKm) * dir
      if (sortBy === 'durationMin') return (a.durationMin - b.durationMin) * dir
      if (sortBy === 'baseName') return a.baseName.localeCompare(b.baseName, 'pt-BR') * dir
      return a.description.localeCompare(b.description, 'pt-BR') * dir
    })
  }, [assignments, baseFilter, outlierIds, pinnedServices, search, showOnlyPinned, showOutliers, sourceFilter, sortBy, sortDir])

  // Distribuição sem nenhuma fixação — usada para mostrar "base original" no painel de fixações
  const autoAssignments = useMemo(
    () => assignServices(services, bases, routeIndex, allocationMode, {}, trafficFactor),
    [services, bases, routeIndex, allocationMode, trafficFactor],
  )

  const originalBaseMap = useMemo(
    () => new Map(autoAssignments.map((a) => [a.id, a.baseName])),
    [autoAssignments],
  )

  const totalKm = useMemo(() => assignments.reduce((sum, i) => sum + i.distanceKm, 0), [assignments])
  const totalMin = useMemo(() => assignments.reduce((sum, i) => sum + i.durationMin, 0), [assignments])
  const overloadedBases = summaries.filter((i) => i.saturation > 1).length
  const osrmCount = routeIndex ? routeIndex.sidMap.size : 0
  const osrmCoverage = services.length ? (osrmCount / services.length) * 100 : 0
  const excludedOutlierCount = outlierIds.size
  const pinnedCount = Object.keys(pinnedServices).length
  const longServiceCount = assignments.filter((i) => i.distanceKm > 30 || i.durationMin > 45).length
  const scenarioComparisons = useMemo(
    () => buildScenarioComparisons(services, bases, routeIndex, pinnedServices, trafficFactor),
    [services, bases, routeIndex, pinnedServices, trafficFactor],
  )
  const operationalRankings = useMemo(
    () => buildOperationalRankings(assignments, summaries, qualityIssues),
    [assignments, summaries, qualityIssues],
  )
  const changedServiceIds = useMemo(
    () => buildChangedServiceSet(services, bases, routeIndex, pinnedServices, trafficFactor),
    [services, bases, routeIndex, pinnedServices, trafficFactor],
  )

  function handleSort(field: SortField) {
    if (sortBy === field) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortBy(field); setSortDir('asc') }
  }

  function toggleMapLayer(layer: keyof MapLayers) {
    setMapLayers((current) => ({ ...current, [layer]: !current[layer] }))
  }

  function pinService(serviceId: number, baseId: string) {
    setPinnedServices((prev) => ({ ...prev, [serviceId]: baseId }))
  }

  function unpinService(serviceId: number) {
    setPinnedServices((prev) => { const n = { ...prev }; delete n[serviceId]; return n })
  }

  function clearAllPins() {
    setPinnedServices({})
  }

  // ─── Data loading ───────────────────────────────────────────────────────────

  async function loadData() {
    try {
      const [sRes, bRes, rRes] = await Promise.all([
        fetch(SERVICES_FILE),
        fetch(BASES_FILE),
        fetch(ROUTES_FILE),
      ])

      if (!sRes.ok || !bRes.ok) {
        setStatus('Arquivos de dados não encontrados. Execute: npm run build:data')
        setLoading(false)
        return
      }

      const [servicesData, basesData] = await Promise.all([
        sRes.json() as Promise<ServiceRow[]>,
        bRes.json() as Promise<BaseRow[]>,
      ])

      setServices(servicesData)
      setBases(basesData)

      if (rRes.ok) {
        const routesData = await rRes.json() as CompactRoutes
        setRouteIndex(buildRouteIndex(routesData))
        setStatus(`${servicesData.length.toLocaleString('pt-BR')} serviços · ${basesData.length} bases · ${routesData.sids.length.toLocaleString('pt-BR')} com rotas OSRM (${(routesData.sids.length / servicesData.length * 100).toFixed(0)}%)`)
      } else {
        setStatus(`${servicesData.length.toLocaleString('pt-BR')} serviços · ${basesData.length} bases · sem cache OSRM`)
      }

      setLoading(false)
    } catch {
      setStatus('Erro ao carregar dados. Execute: npm run build:data')
      setLoading(false)
    }
  }

  function updateCapacity(baseId: string, capacity: number) {
    setBases((current) => current.map((base) => base.id === baseId ? { ...base, capacity: Math.max(1, capacity) } : base))
  }


  // ─── Exports ─────────────────────────────────────────────────────────────────

  function exportCsv() {
    const header = ['id', 'descricao', 'latitude', 'longitude', 'base_sugerida', 'distancia_km', 'tempo_minutos', 'cenario_transito', 'janela_saida', 'fator_transito', 'fonte', 'fixado']
    const rows = assignments.map((item) => [
      item.id,
      `"${item.description.replace(/"/g, '""')}"`,
      item.lat,
      item.lng,
      `"${item.baseName.replace(/"/g, '""')}"`,
      item.distanceKm.toFixed(2),
      Math.round(item.durationMin),
      `"${TRAFFIC_SCENARIOS[trafficScenario].label}"`,
      `"${TIME_WINDOWS[timeWindow].label}"`,
      trafficFactor.toFixed(2),
      item.source === 'osrm' ? 'OSRM' : 'Estimado',
      pinnedServices[item.id] ? 'Sim' : '',
    ])
    const csv = [header, ...rows].map((row) => row.join(',')).join('\r\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'planejamento-servicos.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  function exportExcel() {
    const serviceRows = assignments.map((item) => ({
      id: item.id,
      descricao: item.description,
      latitude: item.lat,
      longitude: item.lng,
      base_sugerida: item.baseName,
      distancia_km: Number(item.distanceKm.toFixed(2)),
      tempo_minutos: Math.round(item.durationMin),
      cenario_transito: TRAFFIC_SCENARIOS[trafficScenario].label,
      janela_saida: TIME_WINDOWS[timeWindow].label,
      fator_transito: Number(trafficFactor.toFixed(2)),
      fonte: item.source === 'osrm' ? 'OpenStreetMap/OSRM' : 'Estimado',
      fixado: pinnedServices[item.id] ? 'Sim' : '',
    }))
    const summaryRows = summaries.map((item) => ({
      base: item.name,
      endereco: item.address,
      capacidade: item.capacity,
      servicos: item.assigned,
      saturacao_percentual: Number((item.saturation * 100).toFixed(2)),
      distancia_total_km: Number(item.totalKm.toFixed(2)),
      distancia_media_km: Number(item.avgKm.toFixed(2)),
      tempo_total_horas: Number((item.totalMin / 60).toFixed(2)),
      tempo_medio_minutos: Math.round(item.avgMin),
      cenario_transito: TRAFFIC_SCENARIOS[trafficScenario].label,
      janela_saida: TIME_WINDOWS[timeWindow].label,
      fator_transito: Number(trafficFactor.toFixed(2)),
    }))
    const issueRows = qualityIssues.map((item) => ({
      id: item.id,
      severidade: item.severity,
      tipo: item.type,
      descricao: item.description,
      latitude: item.lat,
      longitude: item.lng,
      detalhe: item.detail,
    }))
    const scenarioRows = scenarioComparisons.map((item) => ({
      criterio: item.modeLabel,
      distancia_total_km: Number(item.totalKm.toFixed(2)),
      tempo_total_horas: Number((item.totalMin / 60).toFixed(2)),
      distancia_media_km: Number(item.avgKm.toFixed(2)),
      tempo_medio_minutos: Math.round(item.avgMin),
      bases_saturadas: item.overloadedBases,
      cenario_transito: TRAFFIC_SCENARIOS[trafficScenario].label,
      janela_saida: TIME_WINDOWS[timeWindow].label,
      fator_transito: Number(trafficFactor.toFixed(2)),
    }))
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(serviceRows), 'Serviços distribuídos')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), 'Resumo por base')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(scenarioRows), 'Comparador cenários')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(issueRows), 'Qualidade coordenadas')
    XLSX.writeFile(workbook, 'planejamento-servicos.xlsx')
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return <main className="planner-shell"><p className="loading-msg">{status}</p></main>
  }

  return (
    <main className="planner-shell">
      <section className="planner-topbar">
        <div>
          <p className="planner-kicker">MVP de planejamento operacional</p>
          <h1>Distribuição de serviços por base</h1>
        </div>
        <div className="planner-actions">
          <button type="button" className="secondary-button" onClick={exportCsv} disabled={!assignments.length}>CSV</button>
          <button type="button" className="primary-button" onClick={exportExcel} disabled={!assignments.length}>Exportar Excel</button>
        </div>
      </section>

      <section className="status-strip">
        <strong>{status}</strong>
      </section>

      <section className="kpi-row" aria-label="Indicadores principais">
        <Metric label="Serviços" value={services.length.toLocaleString('pt-BR')} />
        <Metric label="Bases" value={bases.length.toString()} />
        <Metric label="Distância total" value={`${formatNumber(totalKm)} km`} />
        <Metric label="Tempo total" value={`${formatNumber(totalMin / 60)} h`} />
        <Metric label="Bases saturadas" value={overloadedBases.toString()} tone={overloadedBases ? 'warn' : 'ok'} />
        <Metric label="Alertas coord." value={qualityIssues.length.toString()} tone={qualityIssues.some((i) => i.severity === 'Crítico') ? 'warn' : 'ok'} />
        <Metric label="Cobertura OSRM" value={`${osrmCount.toLocaleString('pt-BR')} (${formatPercent(osrmCoverage)})`} />
      </section>

      <nav className="view-tabs" aria-label="Visões do planejamento">
        <button className={activeView === 'operation' ? 'active' : ''} onClick={() => setActiveView('operation')}>Operação</button>
        <button className={activeView === 'analysis' ? 'active' : ''} onClick={() => setActiveView('analysis')}>Análise</button>
        <button className={activeView === 'quality' ? 'active' : ''} onClick={() => setActiveView('quality')}>Qualidade</button>
      </nav>

      {activeView === 'operation' && (
        <section className="workspace-grid">
          <aside className="control-panel">
            <h2>Parâmetros</h2>

            <div className="field-group">
              <label>Critério de distribuição</label>
              <div className="segmented">
                <button className={allocationMode === 'distance' ? 'active' : ''} onClick={() => setAllocationMode('distance')}>Distância</button>
                <button className={allocationMode === 'balanced' ? 'active' : ''} onClick={() => setAllocationMode('balanced')}>Equilíbrio</button>
                <button className={allocationMode === 'capacity' ? 'active' : ''} onClick={() => setAllocationMode('capacity')}>Capacidade</button>
              </div>
            </div>

            <label className="form-row">
              Cenário de trânsito
              <select value={trafficScenario} onChange={(e) => setTrafficScenario(e.target.value as TrafficScenario)}>
                {(Object.entries(TRAFFIC_SCENARIOS) as Array<[TrafficScenario, typeof TRAFFIC_SCENARIOS[TrafficScenario]]>).map(([key, scenario]) => (
                  <option key={key} value={key}>{scenario.label}</option>
                ))}
              </select>
              <small>{TRAFFIC_SCENARIOS[trafficScenario].detail}</small>
            </label>

            <label className="form-row">
              Janela de saída
              <select value={timeWindow} onChange={(e) => setTimeWindow(e.target.value as TimeWindow)}>
                {(Object.entries(TIME_WINDOWS) as Array<[TimeWindow, typeof TIME_WINDOWS[TimeWindow]]>).map(([key, window]) => (
                  <option key={key} value={key}>{window.label}</option>
                ))}
              </select>
              <small>{TIME_WINDOWS[timeWindow].detail} · fator total {trafficFactor.toFixed(2)}x</small>
            </label>

            <div className="field-group">
              <label>Camadas do mapa</label>
              <div className="layer-toggles">
                <button type="button" className={mapLayers.services ? 'active' : ''} onClick={() => toggleMapLayer('services')}>Serviços</button>
                <button type="button" className={mapLayers.bases ? 'active' : ''} onClick={() => toggleMapLayer('bases')}>Bases</button>
                <button type="button" className={mapLayers.heatmap ? 'active' : ''} onClick={() => toggleMapLayer('heatmap')}>Heatmap</button>
                <button type="button" className={mapLayers.regions ? 'active' : ''} onClick={() => toggleMapLayer('regions')}>Zonas</button>
                <button type="button" className={mapLayers.longServices ? 'active' : ''} onClick={() => toggleMapLayer('longServices')}>Longos ({longServiceCount})</button>
                <button type="button" className={mapLayers.saturatedBases ? 'active' : ''} onClick={() => toggleMapLayer('saturatedBases')}>Saturadas</button>
                <button type="button" className={mapLayers.outliers ? 'active' : ''} onClick={() => toggleMapLayer('outliers')}>Outliers</button>
                <button type="button" className={mapLayers.changedServices ? 'active' : ''} onClick={() => toggleMapLayer('changedServices')}>Mudanças</button>
              </div>
            </div>

            <label className="form-row">
              Distância mínima no mapa: {mapDistanceLimit} km
              <input type="range" min="0" max="80" step="5" value={mapDistanceLimit} onChange={(e) => setMapDistanceLimit(Number(e.target.value))} />
            </label>

            <label className="form-row">
              Tempo mínimo no mapa: {mapTimeLimit} min
              <input type="range" min="0" max="120" step="5" value={mapTimeLimit} onChange={(e) => setMapTimeLimit(Number(e.target.value))} />
            </label>

            <label className="form-row">
              Linhas base-serviço
              <select value={connectionMode} onChange={(e) => setConnectionMode(e.target.value as ConnectionMode)}>
                <option value="off">Desligadas</option>
                <option value="selected">Base selecionada</option>
                <option value="long">Serviços longos</option>
                <option value="all">Todas visíveis</option>
              </select>
            </label>

            <label className="form-row">
              Intensidade do heatmap
              <select value={heatMetric} onChange={(e) => setHeatMetric(e.target.value as HeatMetric)}>
                <option value="count">Quantidade</option>
                <option value="distance">Distância média</option>
                <option value="time">Tempo médio</option>
              </select>
            </label>

            <button
              type="button"
              className={`secondary-button ${showOutliers ? 'active' : ''}`}
              onClick={() => setShowOutliers((value) => !value)}
            >
              {showOutliers ? 'Excluir outliers da operação' : `Incluir outliers na operação (${excludedOutlierCount})`}
            </button>
          </aside>

          <section className="map-panel">
            <PlannerMap
              services={filteredAssignments}
              bases={summaries}
              issues={qualityIssues}
              baseColorMap={baseColorMap}
              activeBaseId={baseFilter}
              layers={mapLayers}
              distanceLimit={mapDistanceLimit}
              timeLimit={mapTimeLimit}
              connectionMode={connectionMode}
              heatMetric={heatMetric}
              changedServiceIds={changedServiceIds}
              onBaseSelect={(baseId) => setBaseFilter(baseId)}
              fullscreen={mapFullscreen}
              onToggleFullscreen={() => setMapFullscreen((value) => !value)}
            />
          </section>

          <aside className="base-panel">
            <h2>Capacidade das bases</h2>
            <div className="base-list">
              {summaries.map((base) => {
                const sat = base.saturation
                const satClass = sat >= 1 ? 'saturated' : sat >= 0.8 ? 'warning' : ''
                const color = baseColorMap.get(base.id) ?? '#2ad184'
                return (
                  <article className={`base-item ${satClass}`} key={base.id}>
                    <div className="base-item-header">
                      <span className="base-color-chip" style={{ background: color }} />
                      <div>
                        <strong>{base.name}</strong>
                        <span>
                          {base.assigned.toLocaleString('pt-BR')} serviços ·
                          {' '}{formatNumber(base.avgKm)} km/serv ·
                          {' '}{Math.round(base.avgMin)} min/serv
                        </span>
                      </div>
                    </div>
                    <input
                      aria-label={`Capacidade ${base.name}`}
                      type="number"
                      min="1"
                      value={base.capacity}
                      onChange={(e) => updateCapacity(base.id, Number(e.target.value))}
                    />
                    <div className="load-bar">
                      <span style={{ width: `${Math.min(100, sat * 100)}%` }} />
                    </div>
                    <span className="sat-label">{formatPercent(sat * 100)} saturação</span>
                  </article>
                )
              })}
            </div>
          </aside>
        </section>
      )}

      {activeView === 'analysis' && (
        <section className="analysis-section">
          <div className="table-toolbar">
            <div>
              <h2>Comparador de cenários</h2>
              <p>Compara critérios de distribuição usando o cenário de trânsito e a janela de saída selecionados.</p>
            </div>
          </div>
          <div className="scenario-grid">
            {scenarioComparisons.map((scenario) => (
              <article className={`scenario-card ${scenario.mode === allocationMode ? 'active' : ''}`} key={scenario.mode}>
                <span>{scenario.modeLabel}</span>
                <strong>{formatNumber(scenario.totalKm)} km</strong>
                <small>{formatNumber(scenario.totalMin / 60)} h · {scenario.overloadedBases} bases saturadas</small>
                <div className="scenario-metrics">
                  <em>{formatNumber(scenario.avgKm)} km/serv</em>
                  <em>{Math.round(scenario.avgMin)} min/serv</em>
                </div>
              </article>
            ))}
          </div>

          <div className="table-toolbar ranking-toolbar">
            <div>
              <h2>Ranking de problemas</h2>
              <p>Serviços e bases que mais pressionam deslocamento, tempo e capacidade.</p>
            </div>
          </div>
          <div className="ranking-grid">
            <RankingList
              title="Serviços mais distantes"
              items={operationalRankings.farServices.map((item) => ({
                key: item.id,
                title: item.description,
                meta: `${item.baseName} · ${formatNumber(item.distanceKm)} km · ${Math.round(item.durationMin)} min`,
              }))}
            />
            <RankingList
              title="Bases mais saturadas"
              items={operationalRankings.saturatedBases.map((item) => ({
                key: item.id,
                title: item.name,
                meta: `${item.assigned.toLocaleString('pt-BR')} serviços · ${formatPercent(item.saturation * 100)} saturação`,
              }))}
            />
            <RankingList
              title="Maior tempo médio"
              items={operationalRankings.slowBases.map((item) => ({
                key: item.id,
                title: item.name,
                meta: `${Math.round(item.avgMin)} min/serv · ${formatNumber(item.avgKm)} km/serv`,
              }))}
            />
            <RankingList
              title="Alertas críticos"
              items={operationalRankings.criticalIssues.map((item) => ({
                key: item.id,
                title: item.type,
                meta: `${item.description} · ${item.detail}`,
              }))}
              emptyText="Sem alertas críticos"
            />
          </div>
        </section>
      )}

      {activeView === 'quality' && (
        <section className="quality-section">
          <div className="table-toolbar">
            <div>
              <h2>Qualidade das coordenadas</h2>
              <p>
                {qualityIssues.length
                  ? `${qualityIssues.length.toLocaleString('pt-BR')} alertas · ${excludedOutlierCount.toLocaleString('pt-BR')} excluídos do mapa`
                  : 'Nenhum alerta encontrado'}
              </p>
            </div>
          </div>
          <div className="quality-grid">
            {qualityIssues.slice(0, 48).map((issue) => (
              <article className={`quality-item ${issue.severity === 'Crítico' ? 'critical' : ''}`} key={issue.id}>
                <span>{issue.severity}</span>
                <strong>{issue.type}</strong>
                <p>{issue.description}</p>
                <small>{issue.detail}</small>
              </article>
            ))}
            {!qualityIssues.length && (
              <p className="quality-empty">A base carregada está consistente para esta primeira análise.</p>
            )}
          </div>
        </section>
      )}

      {activeView === 'operation' && (
        <section className="table-section">
          <div className="table-toolbar">
            <div>
              <h2>Serviços distribuídos</h2>
              <p>
                {filteredAssignments.length > 260
                  ? `Mostrando 260 de ${filteredAssignments.length.toLocaleString('pt-BR')} linhas — use os filtros para refinar`
                  : `${filteredAssignments.length.toLocaleString('pt-BR')} linhas`}
                {pinnedCount > 0 && <span className="pin-badge">{pinnedCount} fixados</span>}
              </p>
            </div>
            <div className="filters">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar defeito ou base" />
              <select value={baseFilter} onChange={(e) => setBaseFilter(e.target.value)}>
                <option value="all">Todas as bases</option>
                {bases.map((base) => <option key={base.id} value={base.id}>{base.name}</option>)}
              </select>
              <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}>
                <option value="all">Todas as fontes</option>
                <option value="osrm">Somente OSRM</option>
                <option value="estimate">Somente estimativa</option>
              </select>
              {pinnedCount > 0 && (
                <button
                  type="button"
                  className={`secondary-button compact ${showOnlyPinned ? 'active' : ''}`}
                  onClick={() => setShowOnlyPinned((v) => !v)}
                >
                  {showOnlyPinned ? 'Ver todos' : `Ver fixações (${pinnedCount})`}
                </button>
              )}
            </div>
          </div>
          {pinnedCount > 0 && (
            <div className="pinned-panel">
              <div className="pinned-panel-header">
                <h3>Fixações manuais ({pinnedCount})</h3>
                <button type="button" className="secondary-button compact" onClick={clearAllPins}>Limpar todas</button>
              </div>
              <table className="pinned-table">
                <thead>
                  <tr>
                    <th>Serviço</th>
                    <th>Base original</th>
                    <th>Base fixada</th>
                    <th>Distância</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(pinnedServices).map((idStr) => {
                    const id = Number(idStr)
                    const service = assignments.find((a) => a.id === id)
                    if (!service) return null
                    return (
                      <tr key={id}>
                        <td title={service.description}>{service.description}</td>
                        <td className="original-base">{originalBaseMap.get(id) ?? '—'}</td>
                        <td className="pinned-base">{service.baseName}</td>
                        <td>{formatNumber(service.distanceKm)} km</td>
                        <td><button className="unpin-btn" title="Remover fixação" onClick={() => unpinService(id)}>×</button></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="service-table-wrap">
            <table className="service-table">
              <thead>
                <tr>
                  <SortTh label="Serviço" field="description" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th>Base sugerida</th>
                  <SortTh label="Distância" field="distanceKm" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortTh label="Tempo" field="durationMin" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th>Fonte</th>
                </tr>
              </thead>
              <tbody>
                {filteredAssignments.slice(0, 260).map((item) => {
                  const isPinned = Boolean(pinnedServices[item.id])
                  return (
                    <tr key={item.id} className={isPinned ? 'pinned-row' : ''}>
                      <td title={item.description}>{item.description}</td>
                      <td>
                        <div className="base-select-wrap">
                          <select
                            className={`base-select ${isPinned ? 'pinned' : ''}`}
                            value={isPinned ? pinnedServices[item.id] : item.baseId}
                            onChange={(e) => pinService(item.id, e.target.value)}
                          >
                            {bases.map((base) => (
                              <option key={base.id} value={base.id}>{base.name}</option>
                            ))}
                          </select>
                          {isPinned && (
                            <button
                              className="unpin-btn"
                              title="Remover fixação"
                              onClick={() => unpinService(item.id)}
                            >×</button>
                          )}
                        </div>
                      </td>
                      <td>{formatNumber(item.distanceKm)} km</td>
                      <td>{Math.round(item.durationMin)} min</td>
                      <td><span className={`source-pill ${item.source}`}>{item.source === 'osrm' ? 'OSRM' : 'Média'}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <article className={`metric ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function RankingList({ title, items, emptyText = 'Sem itens' }: {
  title: string
  items: Array<{ key: string | number; title: string; meta: string }>
  emptyText?: string
}) {
  return (
    <article className="ranking-card">
      <h3>{title}</h3>
      <ol>
        {items.map((item) => (
          <li key={item.key}>
            <strong>{item.title}</strong>
            <span>{item.meta}</span>
          </li>
        ))}
      </ol>
      {!items.length && <p>{emptyText}</p>}
    </article>
  )
}

function SortTh({ label, field, sortBy, sortDir, onSort }: {
  label: string
  field: SortField
  sortBy: SortField
  sortDir: SortDir
  onSort: (f: SortField) => void
}) {
  const active = sortBy === field
  return (
    <th className="sort-header" onClick={() => onSort(field)}>
      {label}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ⇅'}
    </th>
  )
}

function PlannerMap({
  services,
  bases,
  issues,
  baseColorMap,
  activeBaseId,
  layers,
  distanceLimit,
  timeLimit,
  connectionMode,
  heatMetric,
  changedServiceIds,
  onBaseSelect,
  fullscreen,
  onToggleFullscreen,
}: {
  services: Assignment[]
  bases: BaseSummary[]
  issues: QualityIssue[]
  baseColorMap: Map<string, string>
  activeBaseId: string
  layers: MapLayers
  distanceLimit: number
  timeLimit: number
  connectionMode: ConnectionMode
  heatMetric: HeatMetric
  changedServiceIds: Set<number>
  onBaseSelect: (baseId: string) => void
  fullscreen: boolean
  onToggleFullscreen: () => void
}) {
  const mapElement = useRef<HTMLDivElement | null>(null)
  const map = useRef<L.Map | null>(null)
  const clusterGroup = useRef<L.MarkerClusterGroup | null>(null)
  const baseLayer = useRef<L.LayerGroup | null>(null)
  const issueLayer = useRef<L.LayerGroup | null>(null)
  const heatLayer = useRef<L.LayerGroup | null>(null)
  const regionLayer = useRef<L.LayerGroup | null>(null)
  const connectionLayer = useRef<L.LayerGroup | null>(null)
  const routeLayer = useRef<L.LayerGroup | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!mapElement.current || map.current) return

    map.current = L.map(mapElement.current, { preferCanvas: true }).setView([-15.79, -47.88], 10)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map.current)

    clusterGroup.current = L.markerClusterGroup({
      maxClusterRadius: 50,
      chunkedLoading: true,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      iconCreateFunction: (cluster) => {
        const count = cluster.getChildCount()
        return L.divIcon({
          html: `<div class="custom-cluster"><strong>${count}</strong></div>`,
          className: '',
          iconSize: [42, 42],
        })
      },
    })
    map.current.addLayer(clusterGroup.current)

    baseLayer.current = L.layerGroup().addTo(map.current)
    issueLayer.current = L.layerGroup().addTo(map.current)
    heatLayer.current = L.layerGroup().addTo(map.current)
    regionLayer.current = L.layerGroup().addTo(map.current)
    connectionLayer.current = L.layerGroup().addTo(map.current)
    routeLayer.current = L.layerGroup().addTo(map.current)

    map.current.on('click', () => routeLayer.current?.clearLayers())
  }, [])

  useEffect(() => {
    setTimeout(() => map.current?.invalidateSize(), 80)
  }, [fullscreen])

  useEffect(() => {
    if (!map.current || !clusterGroup.current || !baseLayer.current || !issueLayer.current || !heatLayer.current || !regionLayer.current || !connectionLayer.current || !routeLayer.current) return

    clusterGroup.current.clearLayers()
    baseLayer.current.clearLayers()
    issueLayer.current.clearLayers()
    heatLayer.current.clearLayers()
    regionLayer.current.clearLayers()
    connectionLayer.current.clearLayers()
    routeLayer.current.clearLayers()
    abortRef.current?.abort()

    const bounds = L.latLngBounds([
      [DF_BOUNDS.minLat, DF_BOUNDS.minLng],
      [DF_BOUNDS.maxLat, DF_BOUNDS.maxLng],
    ])
    const visibleServices = services.filter((service) => {
      if (distanceLimit && service.distanceKm < distanceLimit) return false
      if (timeLimit && service.durationMin < timeLimit) return false
      if (activeBaseId !== 'all' && service.baseId !== activeBaseId) return false
      if (layers.changedServices && !changedServiceIds.has(service.id)) return false
      return true
    })
    const baseById = new Map(bases.map((base) => [base.id, base]))

    if (layers.heatmap) {
      buildHeatCells(visibleServices, heatMetric).forEach((cell) => {
        const intensity = Math.min(1, cell.score / cell.maxScore)
        L.circleMarker([cell.lat, cell.lng], {
          radius: 10 + intensity * 28,
          color: '#145f3d',
          fillColor: heatMetric === 'count' ? '#23b36c' : heatMetric === 'distance' ? '#f0a22e' : '#d94832',
          fillOpacity: 0.12 + intensity * 0.36,
          weight: 1,
        })
          .bindTooltip(`${cell.count.toLocaleString('pt-BR')} serviços · ${formatNumber(cell.avgDistance)} km médio · ${Math.round(cell.avgTime)} min médio`, { sticky: true })
          .addTo(heatLayer.current!)
      })
    }

    if (layers.regions) {
      buildHeatCells(visibleServices, 'count').slice(0, 120).forEach((cell) => {
        const intensity = Math.min(1, cell.count / 60)
        L.rectangle([
          [cell.lat - 0.009, cell.lng - 0.009],
          [cell.lat + 0.009, cell.lng + 0.009],
        ], {
          color: '#2b6f4b',
          fillColor: '#7ad89f',
          fillOpacity: 0.08 + intensity * 0.24,
          weight: 1,
        })
          .bindTooltip(`Zona operacional · ${cell.count.toLocaleString('pt-BR')} serviços`, { sticky: true })
          .addTo(regionLayer.current!)
      })
    }

    if (connectionMode !== 'off') {
      const lineServices = visibleServices.filter((service) => {
        if (connectionMode === 'selected') return activeBaseId !== 'all' && service.baseId === activeBaseId
        if (connectionMode === 'long') return service.distanceKm > 30 || service.durationMin > 45
        return true
      }).slice(0, connectionMode === 'all' ? 600 : 1200)
      lineServices.forEach((service) => {
        const base = baseById.get(service.baseId)
        if (!base) return
        const color = baseColorMap.get(service.baseId) ?? '#226b49'
        L.polyline([[service.lat, service.lng], [base.lat, base.lng]], {
          color,
          weight: service.distanceKm > 30 || service.durationMin > 45 ? 1.8 : 1,
          opacity: connectionMode === 'all' ? 0.16 : 0.28,
        }).addTo(connectionLayer.current!)
      })
    }

    // Serviços — cor por base, agrupados em cluster
    if (layers.services) visibleServices.forEach((service) => {
      const isLong = service.distanceKm > 30 || service.durationMin > 45
      if (layers.longServices && !isLong) return
      const isChanged = changedServiceIds.has(service.id)
      const color = isChanged && layers.changedServices ? '#111827' : isLong ? '#d94832' : baseColorMap.get(service.baseId) ?? '#2ad184'
      const icon = L.divIcon({
        className: '',
        html: `<div class="service-marker-dot ${isLong ? 'long' : ''} ${isChanged ? 'changed' : ''}" style="background:${color}"></div>`,
        iconSize: [isLong || isChanged ? 12 : 8, isLong || isChanged ? 12 : 8],
        iconAnchor: [isLong || isChanged ? 6 : 4, isLong || isChanged ? 6 : 4],
      })
      L.marker([service.lat, service.lng], { icon, keyboard: false } as L.MarkerOptions)
        .bindTooltip(
          `${service.description}<br>${service.baseName}<br>${formatNumber(service.distanceKm)} km · ${Math.round(service.durationMin)} min`,
          { sticky: true },
        )
        .on('click', (e) => { L.DomEvent.stopPropagation(e); void showOsrmRoute(service, bases) })
        .addTo(clusterGroup.current!)
      bounds.extend([service.lat, service.lng])
    })

    // Bases — destaque visual na base ativa
    if (layers.bases) bases.forEach((base) => {
      if (layers.saturatedBases && base.saturation < 1) return
      const isActive = activeBaseId !== 'all' && base.id === activeBaseId
      const color = baseColorMap.get(base.id) ?? '#46ef98'
      const point = L.latLng(base.lat, base.lng)
      bounds.extend(point)

      if (isActive) {
        // anel externo pulsante para base ativa
        L.circleMarker(point, { radius: 22, color, fillColor: color, fillOpacity: 0.15, weight: 2, dashArray: '4 4' })
          .addTo(baseLayer.current!)
      }

      L.circleMarker(point, {
        radius: isActive ? 14 : 11,
        color: '#071f17',
        fillColor: color,
        fillOpacity: 0.95,
        weight: isActive ? 4 : 2,
      })
        .bindTooltip(
          `<strong>${base.name}</strong><br>${base.assigned.toLocaleString('pt-BR')} serviços · ${formatNumber(base.avgKm)} km/serv<br>${formatPercent(base.saturation * 100)} saturação`,
          { sticky: true },
        )
        .on('click', (event) => {
          L.DomEvent.stopPropagation(event)
          onBaseSelect(isActive ? 'all' : base.id)
        })
        .addTo(baseLayer.current!)
    })

    // Alertas de qualidade
    if (layers.outliers) issues.slice(0, 160).forEach((issue) => {
      const point = L.latLng(issue.lat, issue.lng)
      bounds.extend(point)
      L.circleMarker(point, {
        radius: 8,
        color: issue.severity === 'Crítico' ? '#8a1f1f' : '#7a5400',
        fillColor: issue.severity === 'Crítico' ? '#ff6b5f' : '#ffd166',
        fillOpacity: 0.85,
        weight: 2,
      })
        .bindTooltip(`${issue.severity}: ${issue.type}<br>${issue.description}<br>${issue.detail}`, { sticky: true })
        .addTo(issueLayer.current!)
    })

    if (bounds.isValid()) map.current.fitBounds(bounds.pad(0.08), { maxZoom: 12 })
  }, [activeBaseId, baseColorMap, bases, changedServiceIds, connectionMode, distanceLimit, heatMetric, issues, layers, onBaseSelect, services, timeLimit])

  async function showOsrmRoute(service: Assignment, currentBases: BaseSummary[]) {
    if (!map.current || !routeLayer.current) return
    routeLayer.current.clearLayers()
    abortRef.current?.abort()
    abortRef.current = new AbortController()

    const base = currentBases.find((b) => b.id === service.baseId)
    if (!base) return

    const color = baseColorMap.get(service.baseId) ?? '#46ef98'

    // Linha tracejada enquanto carrega
    L.polyline([[service.lat, service.lng], [base.lat, base.lng]], {
      color: '#888', weight: 2, dashArray: '6 4', opacity: 0.5,
    }).addTo(routeLayer.current)

    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${service.lng},${service.lat};${base.lng},${base.lat}?overview=full&geometries=geojson`
      const res = await fetch(url, { signal: abortRef.current.signal })
      const data = await res.json() as {
        code?: string
        routes?: Array<{ geometry: { coordinates: [number, number][] }; distance: number; duration: number }>
      }

      routeLayer.current.clearLayers()
      if (data.code !== 'Ok' || !data.routes?.[0]) return

      const route = data.routes[0]
      const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng] as L.LatLngTuple)

      L.polyline(latlngs, { color, weight: 4, opacity: 0.9 })
        .bindPopup(
          `<strong>${service.description}</strong><br>` +
          `Base: ${base.name}<br>` +
          `${(route.distance / 1000).toFixed(1)} km · ${Math.round(route.duration / 60)} min (rota viária)`,
          { closeButton: true },
        )
        .addTo(routeLayer.current)
        .openPopup()

      map.current.fitBounds(L.polyline(latlngs).getBounds().pad(0.15), { maxZoom: 14 })
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
      routeLayer.current.clearLayers()
    }
  }

  const selectedBase = activeBaseId === 'all' ? null : bases.find((base) => base.id === activeBaseId) ?? null
  const visibleCount = services.filter((service) => {
    if (distanceLimit && service.distanceKm < distanceLimit) return false
    if (timeLimit && service.durationMin < timeLimit) return false
    if (activeBaseId !== 'all' && service.baseId !== activeBaseId) return false
    if (layers.changedServices && !changedServiceIds.has(service.id)) return false
    return true
  }).length

  return (
    <div className={`leaflet-map-shell ${fullscreen ? 'fullscreen' : ''}`}>
      <div ref={mapElement} className="leaflet-map" />
      <button type="button" className="map-fullscreen-button" onClick={onToggleFullscreen}>
        {fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
      </button>
      {selectedBase && (
        <aside className="map-base-summary">
          <button type="button" onClick={() => onBaseSelect('all')}>×</button>
          <span>Base selecionada</span>
          <strong>{selectedBase.name}</strong>
          <small>{selectedBase.assigned.toLocaleString('pt-BR')} serviços · {formatNumber(selectedBase.avgKm)} km/serv · {Math.round(selectedBase.avgMin)} min/serv</small>
          <em>{formatPercent(selectedBase.saturation * 100)} saturação</em>
        </aside>
      )}
      {layers.outliers && (
        <aside className="map-outlier-list">
          <strong>Outliers</strong>
          {issues.slice(0, 6).map((issue) => (
            <button key={issue.id} type="button" onClick={() => map.current?.setView([issue.lat, issue.lng], 14)}>
              <span>{issue.type}</span>
              <small>{issue.description}</small>
            </button>
          ))}
        </aside>
      )}
      <div className="map-legend">
        {bases.map((base) => (
          <div key={base.id} className="legend-item">
            <span className="legend-dot" style={{ background: baseColorMap.get(base.id) ?? '#2ad184' }} />
            <span>{base.name}</span>
          </div>
        ))}
        <div className="legend-item legend-separator">
          <span className="legend-dot" style={{ background: '#46ef98', border: '2px solid #071f17' }} />
          <span>Base</span>
        </div>
        {layers.longServices && <div className="legend-item"><span className="legend-dot long-legend" /><span>Serviço longo</span></div>}
        {layers.changedServices && <div className="legend-item"><span className="legend-dot changed-legend" /><span>Muda de base</span></div>}
        {layers.heatmap && <div className="legend-item"><span className="legend-dot heat-legend" /><span>Heatmap por {heatMetric === 'count' ? 'quantidade' : heatMetric === 'distance' ? 'distância' : 'tempo'}</span></div>}
      </div>
      <div className="map-caption">
        OpenStreetMap · {visibleCount.toLocaleString('pt-BR')} serviços visíveis · clique numa base para filtrar
      </div>
    </div>
  )
}

// ─── Route index ──────────────────────────────────────────────────────────────

function buildRouteIndex(data: CompactRoutes): RouteIndex {
  return {
    sidMap: new Map(data.sids.map((id, i) => [id, i])),
    bidMap: new Map(data.bids.map((id, i) => [id, i])),
    d: data.d,
    t: data.t,
  }
}

function getRouteValue(
  service: ServiceRow,
  base: BaseRow,
  routeIndex: RouteIndex | null,
): RouteValue {
  if (routeIndex) {
    const si = routeIndex.sidMap.get(service.id)
    const bi = routeIndex.bidMap.get(base.id)
    if (si !== undefined && bi !== undefined) {
      const d = routeIndex.d[si]?.[bi]
      const t = routeIndex.t[si]?.[bi]
      if (d != null && t != null) return { distanceKm: d, durationMin: t, source: 'osrm' }
    }
  }
  return estimateRoute(service, base)
}

// ─── Business logic ───────────────────────────────────────────────────────────

function assignServices(
  services: ServiceRow[],
  bases: BaseRow[],
  routeIndex: RouteIndex | null,
  mode: AllocationMode,
  pinnedServices: Record<number, string>,
  trafficFactor = 1,
): Assignment[] {
  const load: Record<string, number> = Object.fromEntries(bases.map((b) => [b.id, 0]))

  return services.map((service) => {
    const pinnedBaseId = pinnedServices[service.id]
    if (pinnedBaseId) {
      const pinnedBase = bases.find((b) => b.id === pinnedBaseId)
      if (pinnedBase) {
        load[pinnedBase.id] += 1
        const route = getRouteValue(service, pinnedBase, routeIndex)
        return { ...service, baseId: pinnedBase.id, baseName: pinnedBase.name, distanceKm: route.distanceKm, durationMin: route.durationMin * trafficFactor, source: route.source }
      }
    }

    const ranked = bases.map((base) => {
      const route = getRouteValue(service, base, routeIndex)
      const utilization = load[base.id] / Math.max(1, base.capacity)
      const capacityPenalty = mode === 'distance' ? 0 : utilization * (mode === 'capacity' ? 1.9 : 1.05)
      const overloadPenalty = mode === 'distance' ? 0 : Math.max(0, load[base.id] - base.capacity) * 0.03
      return { base, route, score: route.distanceKm * (1 + capacityPenalty + overloadPenalty) }
    }).sort((a, b) => a.score - b.score)
    const winner = ranked[0]
    load[winner.base.id] += 1
    return { ...service, baseId: winner.base.id, baseName: winner.base.name, distanceKm: winner.route.distanceKm, durationMin: winner.route.durationMin * trafficFactor, source: winner.route.source }
  })
}

function summarizeBases(bases: BaseRow[], assignments: Assignment[]): BaseSummary[] {
  const byBase = new Map<string, Assignment[]>()
  for (const a of assignments) {
    const list = byBase.get(a.baseId) ?? []
    list.push(a)
    byBase.set(a.baseId, list)
  }
  return bases.map((base) => {
    const assigned = byBase.get(base.id) ?? []
    const totalKm = assigned.reduce((sum, i) => sum + i.distanceKm, 0)
    const totalMin = assigned.reduce((sum, i) => sum + i.durationMin, 0)
    const count = assigned.length
    return {
      ...base,
      assigned: count,
      totalKm,
      totalMin,
      avgKm: count ? totalKm / count : 0,
      avgMin: count ? totalMin / count : 0,
      saturation: count / Math.max(1, base.capacity),
    }
  }).sort((a, b) => b.assigned - a.assigned)
}

function auditCoordinateQuality(
  services: ServiceRow[],
  bases: BaseRow[],
  routeIndex: RouteIndex | null,
): QualityIssue[] {
  if (!services.length || !bases.length) return []

  const lats = services.map((s) => s.lat)
  const lngs = services.map((s) => s.lng)
  const minLat = percentile(lats, 0.01)
  const maxLat = percentile(lats, 0.99)
  const minLng = percentile(lngs, 0.01)
  const maxLng = percentile(lngs, 0.99)
  const issues: QualityIssue[] = []

  services.forEach((service) => {
    const outsideDf = service.lat < DF_BOUNDS.minLat || service.lat > DF_BOUNDS.maxLat || service.lng < DF_BOUNDS.minLng || service.lng > DF_BOUNDS.maxLng
    const outsideCluster = service.lat < minLat - 0.08 || service.lat > maxLat + 0.08 || service.lng < minLng - 0.08 || service.lng > maxLng + 0.08

    if (outsideDf || outsideCluster) {
      issues.push({
        id: `range-${service.id}`,
        serviceId: service.id,
        type: outsideDf ? 'Fora do DF' : 'Fora do agrupamento',
        severity: outsideDf ? 'Crítico' : 'Alerta',
        description: service.description,
        lat: service.lat,
        lng: service.lng,
        detail: `Coord. ${service.lat.toFixed(6)}, ${service.lng.toFixed(6)}`,
        excludeByDefault: true,
      })
    }

    const minDist = Math.min(...bases.map((base) => getRouteValue(service, base, routeIndex).distanceKm))
    if (minDist > 120) {
      issues.push({
        id: `far-${service.id}`,
        serviceId: service.id,
        type: 'Muito distante',
        severity: 'Crítico',
        description: service.description,
        lat: service.lat,
        lng: service.lng,
        detail: `Menor rota ${formatNumber(minDist)} km`,
        excludeByDefault: true,
      })
    }
  })

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'Crítico' ? -1 : 1))
}

function buildScenarioComparisons(
  services: ServiceRow[],
  bases: BaseRow[],
  routeIndex: RouteIndex | null,
  pinnedServices: Record<number, string>,
  trafficFactor: number,
) {
  return ([
    ['distance', 'Distância'],
    ['balanced', 'Equilíbrio'],
    ['capacity', 'Capacidade'],
  ] as Array<[AllocationMode, string]>).map(([mode, modeLabel]) => {
    const assignments = assignServices(services, bases, routeIndex, mode, pinnedServices, trafficFactor)
    const summaries = summarizeBases(bases, assignments)
    const totalKm = assignments.reduce((sum, item) => sum + item.distanceKm, 0)
    const totalMin = assignments.reduce((sum, item) => sum + item.durationMin, 0)
    const count = Math.max(1, assignments.length)
    return {
      mode,
      modeLabel,
      totalKm,
      totalMin,
      avgKm: totalKm / count,
      avgMin: totalMin / count,
      overloadedBases: summaries.filter((item) => item.saturation > 1).length,
    }
  })
}

function buildOperationalRankings(assignments: Assignment[], summaries: BaseSummary[], issues: QualityIssue[]) {
  return {
    farServices: [...assignments]
      .sort((a, b) => b.distanceKm - a.distanceKm)
      .slice(0, 8),
    saturatedBases: [...summaries]
      .sort((a, b) => b.saturation - a.saturation)
      .slice(0, 8),
    slowBases: [...summaries]
      .sort((a, b) => b.avgMin - a.avgMin)
      .slice(0, 8),
    criticalIssues: issues
      .filter((item) => item.severity === 'Crítico')
      .slice(0, 8),
  }
}

function buildChangedServiceSet(
  services: ServiceRow[],
  bases: BaseRow[],
  routeIndex: RouteIndex | null,
  pinnedServices: Record<number, string>,
  trafficFactor: number,
) {
  const distance = assignServices(services, bases, routeIndex, 'distance', pinnedServices, trafficFactor)
  const capacity = assignServices(services, bases, routeIndex, 'capacity', pinnedServices, trafficFactor)
  const capacityById = new Map(capacity.map((item) => [item.id, item.baseId]))
  return new Set(distance.filter((item) => capacityById.get(item.id) !== item.baseId).map((item) => item.id))
}

function buildHeatCells(services: Assignment[], metric: HeatMetric) {
  const cells = new Map<string, { latSum: number; lngSum: number; distanceSum: number; timeSum: number; count: number }>()
  services.forEach((service) => {
    const latKey = Math.round(service.lat / 0.015)
    const lngKey = Math.round(service.lng / 0.015)
    const key = `${latKey}:${lngKey}`
    const cell = cells.get(key) ?? { latSum: 0, lngSum: 0, distanceSum: 0, timeSum: 0, count: 0 }
    cell.latSum += service.lat
    cell.lngSum += service.lng
    cell.distanceSum += service.distanceKm
    cell.timeSum += service.durationMin
    cell.count += 1
    cells.set(key, cell)
  })
  const mapped = [...cells.values()].map((cell) => {
    const avgDistance = cell.distanceSum / cell.count
    const avgTime = cell.timeSum / cell.count
    const score = metric === 'count' ? cell.count : metric === 'distance' ? avgDistance : avgTime
    return { lat: cell.latSum / cell.count, lng: cell.lngSum / cell.count, count: cell.count, avgDistance, avgTime, score, maxScore: 1 }
  })
  const maxScore = Math.max(1, ...mapped.map((cell) => cell.score))
  return mapped
    .map((cell) => ({ ...cell, maxScore }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 220)
}


// ─── Utilities ────────────────────────────────────────────────────────────────

function estimateRoute(service: ServiceRow, base: BaseRow): RouteValue {
  const distanceKm = haversineKm(service.lat, service.lng, base.lat, base.lng) * FALLBACK_ROAD_FACTOR
  return { distanceKm, durationMin: (distanceKm / FALLBACK_AVG_SPEED) * 60, source: 'estimate' }
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function normalizeText(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function formatNumber(value: number) {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
}

function formatPercent(value: number) {
  return `${value.toLocaleString('pt-BR', { minimumFractionDigits: value > 0 && value < 1 ? 2 : 1, maximumFractionDigits: 2 })}%`
}

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * ratio)))
  return sorted[index]
}

function toRad(value: number) { return value * Math.PI / 180 }
