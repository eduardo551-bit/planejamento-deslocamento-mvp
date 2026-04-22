import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import * as XLSX from 'xlsx'

// ─── Types ───────────────────────────────────────────────────────────────────

type AllocationMode = 'distance' | 'balanced' | 'capacity'
type AppView = 'operation' | 'quality'
type RouteSource = 'osrm' | 'estimate'
type SortField = 'description' | 'baseName' | 'distanceKm' | 'durationMin'
type SortDir = 'asc' | 'desc'
type SourceFilter = 'all' | 'osrm' | 'estimate'

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

// ─── Component ───────────────────────────────────────────────────────────────

export default function PlannerApp() {
  const [services, setServices] = useState<ServiceRow[]>([])
  const [bases, setBases] = useState<BaseRow[]>([])
  const [routeIndex, setRouteIndex] = useState<RouteIndex | null>(null)
  const [loading, setLoading] = useState(true)
  const [allocationMode, setAllocationMode] = useState<AllocationMode>('distance')
  const [activeView, setActiveView] = useState<AppView>('operation')
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

  const assignments = useMemo(
    () => assignServices(services, bases, routeIndex, allocationMode, pinnedServices),
    [services, bases, routeIndex, allocationMode, pinnedServices],
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
    () => assignServices(services, bases, routeIndex, allocationMode, {}),
    [services, bases, routeIndex, allocationMode],
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

  function handleSort(field: SortField) {
    if (sortBy === field) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortBy(field); setSortDir('asc') }
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
    const header = ['id', 'descricao', 'latitude', 'longitude', 'base_sugerida', 'distancia_km', 'tempo_minutos', 'fonte', 'fixado']
    const rows = assignments.map((item) => [
      item.id,
      `"${item.description.replace(/"/g, '""')}"`,
      item.lat,
      item.lng,
      `"${item.baseName.replace(/"/g, '""')}"`,
      item.distanceKm.toFixed(2),
      Math.round(item.durationMin),
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
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(serviceRows), 'Serviços distribuídos')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), 'Resumo por base')
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


            <button
              type="button"
              className={`secondary-button ${showOutliers ? 'active' : ''}`}
              onClick={() => setShowOutliers((value) => !value)}
            >
              {showOutliers ? 'Ocultar outliers' : `Exibir outliers (${excludedOutlierCount})`}
            </button>
          </aside>

          <section className="map-panel">
            <PlannerMap
              services={filteredAssignments}
              bases={summaries}
              issues={showOutliers ? qualityIssues : []}
              baseColorMap={baseColorMap}
              activeBaseId={baseFilter}
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

function PlannerMap({ services, bases, issues, baseColorMap, activeBaseId }: {
  services: Assignment[]
  bases: BaseSummary[]
  issues: QualityIssue[]
  baseColorMap: Map<string, string>
  activeBaseId: string
}) {
  const mapElement = useRef<HTMLDivElement | null>(null)
  const map = useRef<L.Map | null>(null)
  const clusterGroup = useRef<L.MarkerClusterGroup | null>(null)
  const baseLayer = useRef<L.LayerGroup | null>(null)
  const issueLayer = useRef<L.LayerGroup | null>(null)
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
    })
    map.current.addLayer(clusterGroup.current)

    baseLayer.current = L.layerGroup().addTo(map.current)
    issueLayer.current = L.layerGroup().addTo(map.current)
    routeLayer.current = L.layerGroup().addTo(map.current)

    map.current.on('click', () => routeLayer.current?.clearLayers())
  }, [])

  useEffect(() => {
    if (!map.current || !clusterGroup.current || !baseLayer.current || !issueLayer.current || !routeLayer.current) return

    clusterGroup.current.clearLayers()
    baseLayer.current.clearLayers()
    issueLayer.current.clearLayers()
    routeLayer.current.clearLayers()
    abortRef.current?.abort()

    const bounds = L.latLngBounds([
      [DF_BOUNDS.minLat, DF_BOUNDS.minLng],
      [DF_BOUNDS.maxLat, DF_BOUNDS.maxLng],
    ])

    // Serviços — cor por base, agrupados em cluster
    services.forEach((service) => {
      const color = baseColorMap.get(service.baseId) ?? '#2ad184'
      const icon = L.divIcon({
        className: '',
        html: `<div class="service-marker-dot" style="background:${color}"></div>`,
        iconSize: [8, 8],
        iconAnchor: [4, 4],
      })
      L.marker([service.lat, service.lng], { icon })
        .bindTooltip(
          `${service.description}<br>${service.baseName}<br>${formatNumber(service.distanceKm)} km · ${Math.round(service.durationMin)} min`,
          { sticky: true },
        )
        .on('click', (e) => { L.DomEvent.stopPropagation(e); void showOsrmRoute(service, bases) })
        .addTo(clusterGroup.current!)
      bounds.extend([service.lat, service.lng])
    })

    // Bases — destaque visual na base ativa
    bases.forEach((base) => {
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
        .addTo(baseLayer.current!)
    })

    // Alertas de qualidade
    issues.slice(0, 160).forEach((issue) => {
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
  }, [activeBaseId, baseColorMap, bases, issues, services])

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

  return (
    <div className="leaflet-map-shell">
      <div ref={mapElement} className="leaflet-map" />
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
      </div>
      <div className="map-caption">
        OpenStreetMap · {services.length.toLocaleString('pt-BR')} serviços · clique num ponto para ver a rota viária
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
): Assignment[] {
  const load: Record<string, number> = Object.fromEntries(bases.map((b) => [b.id, 0]))

  return services.map((service) => {
    const pinnedBaseId = pinnedServices[service.id]
    if (pinnedBaseId) {
      const pinnedBase = bases.find((b) => b.id === pinnedBaseId)
      if (pinnedBase) {
        load[pinnedBase.id] += 1
        const route = getRouteValue(service, pinnedBase, routeIndex)
        return { ...service, baseId: pinnedBase.id, baseName: pinnedBase.name, distanceKm: route.distanceKm, durationMin: route.durationMin, source: route.source }
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
    return { ...service, baseId: winner.base.id, baseName: winner.base.name, distanceKm: winner.route.distanceKm, durationMin: winner.route.durationMin, source: winner.route.source }
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
