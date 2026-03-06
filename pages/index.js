import { useState, useEffect, useMemo, useRef, memo } from 'react'
import { supabase } from '../lib/supabase'
import * as ChartJS from 'chart.js'
ChartJS.Chart.register(...ChartJS.registerables)

// ─────────────────────────────────────────────────────────────
// DEALERCHART — Chart.js imperative, never remounts canvas
// Updates data in-place via chart.update('none') — no flash
// ─────────────────────────────────────────────────────────────
const DealerChart = memo(function DealerChart({ title, caption, chartData, spot, config }) {
  const canvasRef = useRef(null)
  const chartRef  = useRef(null)

  // Init once on mount
  useEffect(() => {
    if (!canvasRef.current) return
    chartRef.current = new ChartJS.Chart(canvasRef.current, {
      type: 'bar',
      data: { labels: [], datasets: config.datasets.map(d => ({ ...d, data: [] })) },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: config.legend ?? false, labels: { color: '#9ca3af', font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y
                return config.tooltipFmt ? config.tooltipFmt(v, ctx.dataset.label) : `${ctx.dataset.label}: ${v}`
              }
            },
            backgroundColor: '#1f2937', titleColor: '#f9fafb', bodyColor: '#d1d5db',
            borderColor: '#374151', borderWidth: 1,
          },
        },
        scales: {
          x: { ticks: { color: '#9ca3af', font: { size: 10 }, maxRotation: 0 }, grid: { color: '#374151' } },
          y: {
            ticks: {
              color: '#9ca3af', font: { size: 10 },
              callback: config.yFmt || (v => v)
            },
            grid: { color: '#374151' }
          },
        },
      },
    })
    return () => { chartRef.current?.destroy(); chartRef.current = null }
  }, [])

  // Update data imperatively — no remount, no flash
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !chartData?.length) return

    chart.data.labels = chartData.map(r => r.strike.toFixed(0))

    config.datasets.forEach((cfg, i) => {
      chart.data.datasets[i].data           = chartData.map(r => r[cfg.key])
      chart.data.datasets[i].backgroundColor = typeof cfg.color === 'function'
        ? chartData.map(r => cfg.color(r[cfg.key]))
        : cfg.color
    })

    // Spot reference line via annotation plugin or just re-set via custom afterDraw
    chart.options.plugins.spotLine = spot
    chart.update('none')
  }, [chartData, spot])

  return (
    <div className="bg-gray-800 rounded-lg p-5">
      <h3 className="font-bold text-white mb-0.5">{title}</h3>
      <p className="text-gray-400 text-xs mb-4">{caption}</p>
      <div style={{ height: 240, position: 'relative' }}>
        {!chartData?.length && (
          <div className="absolute inset-0 bg-gray-700 rounded animate-pulse" />
        )}
        <canvas ref={canvasRef} style={{ opacity: chartData?.length ? 1 : 0 }} />
      </div>
    </div>
  )
})

// ─────────────────────────────────────────────────────────────
// GAP STATS COMPUTATION HELPERS
// Replicates the six Streamlit tables from gap.py
// ─────────────────────────────────────────────────────────────

function quantile(sorted, q) {
  if (sorted.length === 0) return null
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function distStats(values, window = 250) {
  const slice = values.slice(-window)
  const n = slice.length
  if (n === 0) return null
  const sorted = [...slice].sort((a, b) => a - b)
  const mean = slice.reduce((s, v) => s + v, 0) / n
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(n - 1, 1)
  const stdev = Math.sqrt(variance)
  const q1 = quantile(sorted, 0.25)
  const median = quantile(sorted, 0.5)
  const q3 = quantile(sorted, 0.75)
  const iqr = q3 - q1
  const upper_bound = q3 + 1.5 * iqr
  const deviations = sorted.map(v => Math.abs(v - median)).sort((a, b) => a - b)
  const MAD = quantile(deviations, 0.5)
  return {
    mean: mean.toFixed(2),
    stdev: stdev.toFixed(2),
    q1: q1.toFixed(2),
    median: median.toFixed(2),
    q3: q3.toFixed(2),
    upper_bound: upper_bound.toFixed(2),
    MAD: MAD.toFixed(2),
  }
}

// Table 1 — Unhit Targets (last 10 trading days, volume regimes)
function computeUnhitTargets(data) {
  const dates = [...new Set(data.map(r => r.date).filter(Boolean))].sort()
  const last10 = new Set(dates.slice(-10))
  return data
    .filter(r => last10.has(r.date) && !r.target_achieved_date)
    .map(r => ({
      anchor_1:          r.previous_date,
      anchor_2:          r.date,
      prev_close_TARGET: r.previous_close,
      open:              r.open,
      gap_value:         r.gap_value,
      gap_type:          r.gap_type,
      trade_direction:   r.trade_direction,
      rel_vol:           r.rel_vol_bucket,
      gap_vol:           r.gap_vol_ratio_bucket,
      range_eff:         r.range_eff_bucket,
      day0_vol:          r.day0_vol_share_bucket,
    }))
    .sort((a, b) => (b.anchor_2 || '').localeCompare(a.anchor_2 || ''))
}

// Table 2 — Gap Close Probability by Day (simple cumulative)
function computeGapCloseProb(data) {
  const filtered = data.filter(r => r.gap_type !== 'no_gap' && r.days_to_target != null)
  const grouped = {}
  filtered.forEach(r => {
    if (!grouped[r.gap_type]) grouped[r.gap_type] = []
    grouped[r.gap_type].push(Number(r.days_to_target))
  })
  return Object.entries(grouped)
    .map(([gap_type, vals]) => {
      const total = vals.length
      const row = { gap_type, n: total }
      for (let d = 1; d <= 10; d++) {
        row[`day_${d}`] = (vals.filter(v => v <= d).length / total).toFixed(4)
      }
      return row
    })
    .sort((a, b) => a.gap_type.localeCompare(b.gap_type))
}

// Table 3 — Gap Close Probability by Day (Volume Regimes, post-2009)
const BUCKET_COLS = ['rel_vol_bucket', 'gap_vol_ratio_bucket', 'range_eff_bucket', 'day0_vol_share_bucket']
const REGIME_CUTOFF = '2009-01-01'

function computeRegimeCloseProb(data) {
  const filtered = data.filter(r =>
    r.date >= REGIME_CUTOFF &&
    r.gap_type !== 'no_gap' &&
    r.days_to_target != null &&
    BUCKET_COLS.every(c => r[c] != null)
  )
  const grouped = {}
  filtered.forEach(r => {
    const key = [r.gap_type, r.rel_vol_bucket, r.gap_vol_ratio_bucket, r.range_eff_bucket, r.day0_vol_share_bucket].join('|')
    if (!grouped[key]) grouped[key] = { rows: [], meta: r }
    grouped[key].rows.push(r)
  })
  return Object.values(grouped)
    .sort((a, b) => b.rows.length - a.rows.length)
    .slice(0, 9)
    .map(({ rows, meta }) => {
      const total = rows.length
      const row = {
        regime: `${meta.gap_type} | ${meta.rel_vol_bucket}, ${meta.gap_vol_ratio_bucket}, ${meta.range_eff_bucket}, ${meta.day0_vol_share_bucket}`,
        n: total,
      }
      for (let d = 1; d <= 10; d++) {
        row[`day_${d}`] = (rows.filter(r => Number(r.days_to_target) <= d).length / total).toFixed(4)
      }
      return row
    })
}

// Table 4 — Days to Target Stats (last 250 per gap type)
function computeDaysToTargetStats(data) {
  const filtered = data
    .filter(r => r.gap_type !== 'no_gap' && r.days_to_target != null)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  const grouped = {}
  filtered.forEach(r => {
    if (!grouped[r.gap_type]) grouped[r.gap_type] = []
    grouped[r.gap_type].push(Number(r.days_to_target))
  })
  return Object.entries(grouped)
    .map(([gap_type, vals]) => ({ gap_type, ...distStats(vals) }))
    .filter(r => r.mean != null)
    .sort((a, b) => Number(a.mean) - Number(b.mean))
}

// Table 5 — MAM Stats in Days
function computeMAMDaysStats(data) {
  const filtered = data
    .filter(r => r.gap_type !== 'no_gap' && r.days_to_mam != null)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  const grouped = {}
  filtered.forEach(r => {
    if (!grouped[r.gap_type]) grouped[r.gap_type] = []
    grouped[r.gap_type].push(Number(r.days_to_mam))
  })
  return Object.entries(grouped)
    .map(([gap_type, vals]) => ({ gap_type, ...distStats(vals) }))
    .filter(r => r.mean != null)
    .sort((a, b) => Number(a.mean) - Number(b.mean))
}

// Table 6 — MAM Stats in Points
function computeMAMPtsStats(data) {
  const filtered = data
    .filter(r => r.gap_type !== 'no_gap' && r.days_to_mam != null && r.max_adverse_move != null)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  const grouped = {}
  filtered.forEach(r => {
    if (!grouped[r.gap_type]) grouped[r.gap_type] = []
    grouped[r.gap_type].push(Number(r.max_adverse_move))
  })
  return Object.entries(grouped)
    .map(([gap_type, vals]) => ({ gap_type, ...distStats(vals) }))
    .filter(r => r.mean != null)
    .sort((a, b) => Number(a.mean) - Number(b.mean))
}

// ─── Shared sub-components ────────────────────────────────────

function GapSectionHeader({ title, caption }) {
  return (
    <div className="mb-3">
      <h3 className="text-xl font-bold text-white">{title}</h3>
      {caption && <p className="text-gray-400 text-sm mt-1">{caption}</p>}
    </div>
  )
}

function probColor(val) {
  const n = parseFloat(val)
  if (n >= 0.70) return 'text-green-400 font-semibold'
  if (n >= 0.50) return 'text-yellow-400'
  return 'text-gray-300'
}

const DAY_COLS = Array.from({ length: 10 }, (_, i) => `day_${i + 1}`)
const STAT_COLS = ['mean', 'stdev', 'q1', 'median', 'q3', 'upper_bound', 'MAD']

function UnhitTargetsTable({ data, bucketColor, typeColor }) {
  if (!data.length) return <p className="text-gray-500 text-sm">No unfilled gaps in the last 10 trading days.</p>
  return (
    <div className="overflow-x-auto overflow-y-auto max-h-[340px] rounded-lg border border-gray-700">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-gray-800 z-10 border-b border-gray-700">
          <tr>
            {['Anchor 1','Anchor 2','Prev Close TARGET','Open','Gap $','Gap Type','Direction','Rel Vol','Gap Vol','Range Eff','Day0 Vol'].map((h, i) => (
              <th key={i} className={`p-2 text-gray-400 text-xs font-medium whitespace-nowrap ${i >= 2 ? 'text-right' : 'text-left'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((r, i) => (
            <tr key={i} className="border-b border-gray-700 hover:bg-gray-750 transition-colors">
              <td className="p-2 text-xs font-mono text-gray-400">{r.anchor_1 ?? '—'}</td>
              <td className="p-2 text-xs font-mono font-semibold">{r.anchor_2}</td>
              <td className="text-right p-2 text-xs font-semibold text-yellow-300">{r.prev_close_TARGET?.toFixed(2) ?? '—'}</td>
              <td className="text-right p-2 text-xs">{r.open?.toFixed(2) ?? '—'}</td>
              <td className="text-right p-2 text-xs font-semibold">{r.gap_value != null ? `$${r.gap_value.toFixed(2)}` : '—'}</td>
              <td className={`p-2 text-xs ${typeColor(r.gap_type)}`}>{r.gap_type ?? '—'}</td>
              <td className="p-2 text-xs">
                {r.trade_direction && r.trade_direction !== 'not tradable'
                  ? <span className={`px-2 py-0.5 rounded text-xs font-semibold ${r.trade_direction === 'long' ? 'bg-green-900 text-green-200' : 'bg-red-900 text-red-200'}`}>{r.trade_direction}</span>
                  : <span className="text-gray-600">—</span>}
              </td>
              {[r.rel_vol, r.gap_vol, r.range_eff, r.day0_vol].map((b, bi) => (
                <td key={bi} className="p-2 text-xs">
                  {b ? <span className={`px-2 py-0.5 rounded text-xs font-semibold ${bucketColor(b)}`}>{b}</span> : '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function GapCloseProbTable({ data, typeColor }) {
  if (!data.length) return <p className="text-gray-500 text-sm">No data.</p>
  return (
    <div className="overflow-x-auto overflow-y-auto max-h-[260px] rounded-lg border border-gray-700">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-gray-800 z-10 border-b border-gray-700">
          <tr>
            <th className="p-2 text-gray-400 text-xs text-left">Gap Type</th>
            <th className="p-2 text-gray-400 text-xs text-right">N</th>
            {DAY_COLS.map(d => <th key={d} className="p-2 text-gray-400 text-xs text-right whitespace-nowrap">{d.replace('_', ' ')}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map((r, i) => (
            <tr key={i} className="border-b border-gray-700 hover:bg-gray-750 transition-colors">
              <td className={`p-2 text-xs ${typeColor(r.gap_type)}`}>{r.gap_type}</td>
              <td className="text-right p-2 text-xs text-gray-400">{r.n}</td>
              {DAY_COLS.map(d => <td key={d} className={`text-right p-2 text-xs ${probColor(r[d])}`}>{r[d]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RegimeCloseProbTable({ data }) {
  if (!data.length) return <p className="text-gray-500 text-sm">No data.</p>
  return (
    <div className="overflow-x-auto overflow-y-auto max-h-[320px] rounded-lg border border-gray-700">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-gray-800 z-10 border-b border-gray-700">
          <tr>
            <th className="p-2 text-gray-400 text-xs text-left">Regime</th>
            <th className="p-2 text-gray-400 text-xs text-right">N</th>
            {DAY_COLS.map(d => <th key={d} className="p-2 text-gray-400 text-xs text-right whitespace-nowrap">{d.replace('_', ' ')}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map((r, i) => (
            <tr key={i} className="border-b border-gray-700 hover:bg-gray-750 transition-colors">
              <td className="p-2 text-xs text-gray-200 max-w-xs truncate" title={r.regime}>{r.regime}</td>
              <td className="text-right p-2 text-xs text-gray-400">{r.n}</td>
              {DAY_COLS.map(d => <td key={d} className={`text-right p-2 text-xs ${probColor(r[d])}`}>{r[d]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DistStatsTable({ data, prefix = '', typeColor }) {
  if (!data.length) return <p className="text-gray-500 text-sm">No data.</p>
  return (
    <div className="overflow-x-auto overflow-y-auto max-h-[260px] rounded-lg border border-gray-700">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-gray-800 z-10 border-b border-gray-700">
          <tr>
            <th className="p-2 text-gray-400 text-xs text-left">Gap Type</th>
            {STAT_COLS.map(c => <th key={c} className="p-2 text-gray-400 text-xs text-right">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map((r, i) => (
            <tr key={i} className="border-b border-gray-700 hover:bg-gray-750 transition-colors">
              <td className={`p-2 text-xs ${typeColor(r.gap_type)}`}>{r.gap_type}</td>
              {STAT_COLS.map(c => (
                <td key={c} className="text-right p-2 text-xs font-mono text-gray-200">{prefix}{r[c] ?? '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function Index() {
  const tickers = ['SPY', 'ES', 'MES']
  const chartTimestampRef = useRef(null)

  const [barsByTicker, setBarsByTicker] = useState({})
  const [liveBars, setLiveBars] = useState([])
  const [historicalData, setHistoricalData] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('volume')
  const [selectedTicker, setSelectedTicker] = useState('SPY')
  const [historicalDays, setHistoricalDays] = useState(1)
  const [gapData, setGapData] = useState([])
  const [gapLoading, setGapLoading] = useState(false)
  const [gapDaysFilter, setGapDaysFilter] = useState(30)

  // Full dataset for the 6 computed stat tables
  const [fullGapData, setFullGapData] = useState([])
  const [fullGapLoading, setFullGapLoading] = useState(false)
  const [fullGapFetched, setFullGapFetched] = useState(false)

  // Computed gap stat tables (memoised)
  const unhitTargets      = useMemo(() => computeUnhitTargets(fullGapData),      [fullGapData])
  const gapCloseProb      = useMemo(() => computeGapCloseProb(fullGapData),      [fullGapData])
  const regimeCloseProb   = useMemo(() => computeRegimeCloseProb(fullGapData),   [fullGapData])
  const daysToTargetStats = useMemo(() => computeDaysToTargetStats(fullGapData), [fullGapData])
  const mamDaysStats      = useMemo(() => computeMAMDaysStats(fullGapData),      [fullGapData])
  const mamPtsStats       = useMemo(() => computeMAMPtsStats(fullGapData),       [fullGapData])

  const [oiData, setOiData] = useState([])
  const [greeksData, setGreeksData] = useState([])
  const [allOiData, setAllOiData] = useState([])
  const [allGreeksData, setAllGreeksData] = useState([])
  const [optionsLoading, setOptionsLoading] = useState(false)
  const [optionsSide, setOptionsSide] = useState('all')   // 'all' | 'C' | 'P'
  const [optionsExpiry, setOptionsExpiry] = useState('all')

  // Computed dealer exposure charts (GEX + delta) by strike
  const lastGoodChartData = useRef([])
  const exposureChartData = useMemo(() => {
    if (!allOiData.length || !allGreeksData.length) return lastGoodChartData.current
    const spot = allGreeksData[0]?.spot || 1
    const greeksMap = {}
    allGreeksData.forEach(r => { greeksMap[`${r.strike}_${r.side}`] = r })
    const byStrike = {}
    allOiData.forEach(r => {
      const g = greeksMap[`${r.strike}_${r.side}`]
      if (!byStrike[r.strike]) byStrike[r.strike] = {
        strike: r.strike,
        callGEX: 0, putGEX: 0,
        callDelta: 0, putDelta: 0,
        callVega: 0, putVega: 0,
        callTheta: 0, putTheta: 0,
        callOI: 0, putOI: 0
      }
      const oi = r.open_interest || 0
      const gex   = (g?.gamma || 0) * oi * 100 * spot
      const dex   = (g?.delta || 0) * oi * 100
      const vex   = (g?.vega  || 0) * oi * 100
      const tex   = (g?.theta || 0) * oi * 100
      if (r.side === 'C') {
        byStrike[r.strike].callGEX   += gex
        byStrike[r.strike].callDelta += dex
        byStrike[r.strike].callVega  += vex
        byStrike[r.strike].callTheta += tex
        byStrike[r.strike].callOI    += oi
      } else {
        byStrike[r.strike].putGEX   += gex
        byStrike[r.strike].putDelta += dex
        byStrike[r.strike].putVega  += vex
        byStrike[r.strike].putTheta += tex
        byStrike[r.strike].putOI    += oi
      }
    })
    const result = Object.values(byStrike)
      .map(r => ({
        strike:      r.strike,
        netGEX:      +((r.callGEX - r.putGEX) / 1e6).toFixed(3),
        callGEX:     +(r.callGEX / 1e6).toFixed(3),
        putGEX:      +(-r.putGEX / 1e6).toFixed(3),
        dealerDelta: +((-(r.callDelta - r.putDelta)) / 1e6).toFixed(3),
        netVega:     +((r.callVega + r.putVega) / 1e6).toFixed(3),
        netTheta:    +((r.callTheta + r.putTheta) / 1e6).toFixed(3),
        callOI:      r.callOI,
        putOI:       r.putOI,
      }))
      .sort((a, b) => a.strike - b.strike)
    if (result.length > 0) lastGoodChartData.current = result
    return lastGoodChartData.current
  }, [allOiData, allGreeksData])

  function downloadCSV(data, filename) {
    if (!data || data.length === 0) return
    const headers = Object.keys(data[0])
    const csvContent = [
      headers.join(','),
      ...data.map(row =>
        headers.map(header => {
          const value = row[header]
          if (value === null || value === undefined) return ''
          if (typeof value === 'string' && value.includes(',')) return `"${value}"`
          return value
        }).join(',')
      )
    ].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = filename
    link.click()
  }

  const hoverStyles = `
    <style>
      .scroll-hover-table { transition: max-height 0.3s ease-in-out; }
      .scroll-hover-table:hover { max-height: 800px !important; }
    </style>
  `

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5000)
    return () => clearInterval(interval)
  }, [selectedTicker, historicalDays])

  useEffect(() => {
    if (activeTab === 'gaps') {
      fetchGapData()
      if (!fullGapFetched) fetchFullGapData()
    }
  }, [activeTab, gapDaysFilter])

  useEffect(() => {
    if (activeTab === 'options') {
      fetchOptionsData()
      fetchChartData()
    }
    const fastInterval = activeTab === 'options' ? setInterval(fetchOptionsData, 5000) : null
    const slowInterval = activeTab === 'options' ? setInterval(fetchChartData, 60000) : null
    return () => {
      if (fastInterval) clearInterval(fastInterval)
      if (slowInterval) clearInterval(slowInterval)
    }
  }, [activeTab])

  async function fetchData() {
    try {
      const results = await Promise.all(
        tickers.map(ticker =>
          supabase
            .from('bars_30m')
            .select('*')
            .eq('ticker', ticker)
            .order('timestamp', { ascending: false })
            .limit(20)
        )
      )

      const grouped = {}
      results.forEach((res, idx) => {
        if (res.error) throw res.error
        grouped[tickers[idx]] = res.data || []
      })

      const { data: live, error: liveError } = await supabase
        .from('live_bars')
        .select('*')

      if (liveError && liveError.code !== 'PGRST116') throw liveError

      const daysAgo = new Date()
      daysAgo.setDate(daysAgo.getDate() - historicalDays)

      let historicalQuery = supabase
        .from('bars_30m')
        .select('*')
        .gte('timestamp', daysAgo.toISOString())
        .order('timestamp', { ascending: false })

      if (selectedTicker !== 'All') {
        historicalQuery = historicalQuery.eq('ticker', selectedTicker)
      }

      const { data: historical, error: historicalError } = await historicalQuery
      if (historicalError) throw historicalError

      const tickerOrder = { 'SPY': 1, 'ES': 2, 'MES': 3 }
      let allBars = [...(historical || [])]

      if (live && live.length > 0) {
        const filteredLiveBars = selectedTicker === 'All'
          ? live
          : live.filter(bar => bar.ticker === selectedTicker)
        const markedLiveBars = filteredLiveBars.map(bar => ({ ...bar, isLive: true }))
        allBars = [...markedLiveBars, ...allBars]
      }

      const sortedHistorical = allBars.sort((a, b) => {
        if (a.timestamp !== b.timestamp) return new Date(b.timestamp) - new Date(a.timestamp)
        return (tickerOrder[a.ticker] || 999) - (tickerOrder[b.ticker] || 999)
      })

      setBarsByTicker(grouped)
      setLiveBars(live || [])
      setHistoricalData(sortedHistorical)
      setLoading(false)
    } catch (error) {
      console.error('Error fetching data:', error)
      setLoading(false)
    }
  }

  async function fetchGapData() {
    setGapLoading(true)
    try {
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - gapDaysFilter)
      const cutoffStr = cutoff.toISOString().split('T')[0]

      const { data, error } = await supabase
        .from('yf_gaps_data')
        .select('*')
        .gte('date', cutoffStr)
        .order('date', { ascending: false })

      if (error) throw error
      setGapData(data || [])
    } catch (error) {
      console.error('Error fetching gap data:', error)
    }
    setGapLoading(false)
  }

  // Fetches the entire yf_gaps_data table (paginated) for stat computations
  async function fetchFullGapData() {
    setFullGapLoading(true)
    try {
      let all = []
      let from = 0
      const PAGE = 1000
      while (true) {
        const { data, error } = await supabase
          .from('yf_gaps_data')
          .select('*')
          .order('date', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) throw error
        all = all.concat(data || [])
        if (!data || data.length < PAGE) break
        from += PAGE
      }
      setFullGapData(all)
      setFullGapFetched(true)
    } catch (error) {
      console.error('Error fetching full gap data:', error)
    }
    setFullGapLoading(false)
  }

  async function fetchOptionsData() {
    setOptionsLoading(true)
    try {
      const today = new Date().toISOString().split('T')[0]

      // Today's OI snapshot — top 200 by OI
      const { data: oi, error: oiErr } = await supabase
        .from('options_oi_daily')
        .select('expiration, strike, side, open_interest, prev_close, dte_trading')
        .eq('snapshot_date', today)
        .eq('symbol', 'SPY')
        .not('open_interest', 'is', null)
        .gt('open_interest', 0)
        .order('open_interest', { ascending: false })
        .limit(200)
      if (oiErr) throw oiErr

      // Latest greeks snapshot — get most recent timestamp first
      const { data: latestTs, error: tsErr } = await supabase
        .from('options_greeks_live')
        .select('timestamp')
        .eq('snapshot_date', today)
        .order('timestamp', { ascending: false })
        .limit(1)
      if (tsErr) throw tsErr

      let greeks = []
      if (latestTs && latestTs.length > 0) {
        const ts = latestTs[0].timestamp
        const { data: g, error: gErr } = await supabase
          .from('options_greeks_live')
          .select('timestamp, expiration, strike, side, spot, iv, delta, gamma, theta, vega, ask_gamma, ask_delta, ask_theta, ask_vega, bid, ask, volume, dte_trading')
          .eq('timestamp', ts)
          .not('ask_gamma', 'is', null)
          .order('ask_gamma', { ascending: false })
          .limit(150)
        if (gErr) throw gErr
        greeks = g || []
      }

      setOiData(oi || [])
      setGreeksData(greeks)
    } catch (err) {
      console.error('Options fetch error:', err)
    }
    setOptionsLoading(false)
  }

  // Separate slower fetch for dealer exposure charts — no need to refresh every 5s
  async function fetchChartData() {
    try {
      const today = new Date().toISOString().split('T')[0]

      const { data: allOi } = await supabase
        .from('options_oi_daily')
        .select('strike, side, open_interest')
        .eq('snapshot_date', today)
        .eq('symbol', 'SPY')
        .not('open_interest', 'is', null)
        .gt('open_interest', 0)

      const { data: latestTs } = await supabase
        .from('options_greeks_live')
        .select('timestamp')
        .eq('snapshot_date', today)
        .order('timestamp', { ascending: false })
        .limit(1)

      let allG = []
      if (latestTs && latestTs.length > 0) {
        const ts2 = latestTs[0].timestamp

        // Only re-fetch and re-render if the greeks timestamp has actually changed
        if (ts2 === chartTimestampRef.current) return
        chartTimestampRef.current = ts2

        const { data: gAll } = await supabase
          .from('options_greeks_live')
          .select('strike, side, delta, gamma, theta, vega, spot')
          .eq('timestamp', ts2)
        allG = gAll || []
      }

      if (allOi?.length) setAllOiData(allOi)
      if (allG.length)   setAllGreeksData(allG)
    } catch (err) {
      console.error('Chart data fetch error:', err)
    }
  }

  function gapTypeColor(gapType) {
    if (!gapType) return 'text-gray-400'
    if (gapType.includes('up')) return 'text-red-400'
    if (gapType.includes('down')) return 'text-green-400'
    return 'text-gray-400'
  }

  function volBucketColor(bucket) {
    if (bucket === 'high') return 'bg-orange-900 text-orange-200'
    if (bucket === 'low') return 'bg-blue-900 text-blue-200'
    return 'bg-gray-700 text-gray-300'
  }

  // Reusable delta % cell color
  function deltaPctColor(val) {
    if ((val || 0) > 0) return 'text-green-400'
    if ((val || 0) < 0) return 'text-red-400'
    return 'text-gray-400'
  }

  // Reusable pressure ratio cell color
  function pressureColor(val) {
    if ((val || 0) > 1.2) return 'text-green-400'
    if ((val || 0) < 0.8) return 'text-red-400'
    return 'text-gray-400'
  }

  // Reusable z-score cell color (SD tiers)
  function zscoreColor(val) {
    if (Math.abs(val || 0) > 2) return 'text-red-400'
    if (Math.abs(val || 0) > 1) return 'text-yellow-400'
    return 'text-green-400'
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-900">
        <p className="text-xl text-white">Loading...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen p-8 bg-gray-900 text-white">
      <div className="max-w-[1800px] mx-auto">
        <div dangerouslySetInnerHTML={{ __html: hoverStyles }} />

        <div className="mb-6">
          <h1 className="text-4xl font-bold mb-2">Trading Dashboard</h1>
          <p className="text-gray-400">Timeband-based volume analytics + order flow</p>
        </div>

        {/* Tab Nav */}
        <div className="flex gap-2 mb-8 border-b border-gray-700">
          <button
            onClick={() => setActiveTab('volume')}
            className={`px-6 py-3 font-semibold text-sm rounded-t transition-colors ${
              activeTab === 'volume'
                ? 'bg-gray-800 text-white border border-b-0 border-gray-700'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Volume
          </button>
          <button
            onClick={() => setActiveTab('gaps')}
            className={`px-6 py-3 font-semibold text-sm rounded-t transition-colors ${
              activeTab === 'gaps'
                ? 'bg-gray-800 text-white border border-b-0 border-gray-700'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Gap Analysis
          </button>
          <button
            onClick={() => setActiveTab('options')}
            className={`px-6 py-3 font-semibold text-sm rounded-t transition-colors ${
              activeTab === 'options'
                ? 'bg-gray-800 text-white border border-b-0 border-gray-700'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Options
          </button>
        </div>

        {/* ════════════════════════════════════════
            VOLUME TAB
        ════════════════════════════════════════ */}
        {activeTab === 'volume' && (
          <>
            {/* Per-ticker recent bars tables */}
            {tickers.map(ticker => {
              const bars = barsByTicker[ticker] || []
              const currentLiveBar = liveBars.find(b => b.ticker === ticker)

              return (
                <div key={ticker} className="bg-gray-800 rounded-lg shadow-xl p-6 mb-12">
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="text-2xl font-bold">Recent Bars — {ticker}</h2>
                    <button
                      onClick={() => downloadCSV(
                        [currentLiveBar, ...bars].filter(Boolean),
                        `${ticker}_recent_bars_${new Date().toISOString().split('T')[0]}.csv`
                      )}
                      className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded font-semibold text-sm"
                    >
                      Download CSV
                    </button>
                  </div>

                  <div className="overflow-x-auto overflow-y-auto max-h-[400px] scroll-hover-table rounded-lg">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-gray-800 z-10">
                        <tr className="border-b border-gray-700">
                          <th className="text-left p-2 text-gray-400 text-sm">Time</th>
                          <th className="text-left p-2 text-gray-400 text-sm">Band</th>
                          <th className="text-right p-2 text-gray-400 text-sm">Volume</th>
                          <th className="text-right p-2 text-gray-400 text-sm">Agg Buy</th>
                          <th className="text-right p-2 text-gray-400 text-sm">Agg Sell</th>
                          <th className="text-right p-2 text-gray-400 text-sm">Passive Vol</th>
                          <th className="text-right p-2 text-gray-400 text-sm">Buy-Sell Δ</th>
                          <th className="text-right p-2 text-gray-400 text-sm">B-S Δ %</th>
                          <th className="text-right p-2 text-gray-400 text-sm">Pressure</th>
                          <th className="text-right p-2 text-gray-400 text-sm">% Chg</th>
                          <th className="text-right p-2 text-gray-400 text-sm">Avg 20D</th>
                          <th className="text-right p-2 text-gray-400 text-sm">Z-Score</th>
                          <th className="text-right p-2 text-gray-400 text-sm">Ratio</th>
                          <th className="text-left p-2 text-gray-400 text-sm">Session</th>
                        </tr>
                      </thead>

                      <tbody>
                        {/* LIVE ROW */}
                        {currentLiveBar && (
                          <tr className="border-b-2 border-blue-500 bg-gradient-to-r from-blue-900/40 to-blue-800/40">

                            {/* 1. Time — pulsing LIVE indicator */}
                            <td className="p-2 font-bold text-sm">
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
                                LIVE
                              </div>
                            </td>

                            {/* 2. Band */}
                            <td className="p-2 font-mono font-bold text-sm">
                              {currentLiveBar.timeband}
                            </td>

                            {/* 3. Volume */}
                            <td className="text-right p-2 font-bold text-blue-300 text-sm">
                              {currentLiveBar.volume?.toLocaleString()}
                            </td>

                            {/* 4. Agg Buy */}
                            <td className="text-right p-2 text-sm text-green-400">
                              {currentLiveBar.buy_volume?.toLocaleString() || '-'}
                            </td>

                            {/* 5. Agg Sell */}
                            <td className="text-right p-2 text-sm text-red-400">
                              {currentLiveBar.sell_volume?.toLocaleString() || '-'}
                            </td>

                            {/* 6. Passive Vol */}
                            <td className="text-right p-2 text-sm text-gray-500">
                              {currentLiveBar.passive_volume?.toLocaleString() || '-'}
                            </td>

                            {/* 7. Buy-Sell Δ */}
                            <td className={`text-right p-2 font-bold text-sm ${
                              (currentLiveBar.delta || 0) > 0 ? 'text-green-400'
                                : (currentLiveBar.delta || 0) < 0 ? 'text-red-400'
                                : 'text-gray-400'
                            }`}>
                              {currentLiveBar.delta !== null && currentLiveBar.delta !== undefined
                                ? (currentLiveBar.delta >= 0 ? '+' : '') + currentLiveBar.delta.toLocaleString()
                                : '-'}
                            </td>

                            {/* 8. B-S Δ % */}
                            <td className={`text-right p-2 font-bold text-sm ${deltaPctColor(currentLiveBar.delta_pct)}`}>
                              {currentLiveBar.delta_pct !== null && currentLiveBar.delta_pct !== undefined
                                ? (() => {
                                    const pct = currentLiveBar.delta_pct
                                      ? currentLiveBar.delta_pct.toFixed(1)
                                      : currentLiveBar.buy_volume && currentLiveBar.sell_volume
                                        ? ((currentLiveBar.delta / (currentLiveBar.buy_volume + currentLiveBar.sell_volume)) * 100).toFixed(1)
                                        : '0'
                                    return `${pct}%`
                                  })()
                                : '-'}
                            </td>

                            {/* 9. Pressure — threshold coloring */}
                            <td className={`text-right p-2 font-bold text-sm ${pressureColor(currentLiveBar.pressure_ratio)}`}>
                              {currentLiveBar.pressure_ratio !== null && currentLiveBar.pressure_ratio !== undefined
                                ? currentLiveBar.pressure_ratio.toFixed(2)
                                : '-'}
                            </td>

                            {/* 10. % Chg */}
                            <td className={`text-right p-2 font-bold text-sm ${
                              ((currentLiveBar.close - currentLiveBar.open) / currentLiveBar.open * 100) >= 0
                                ? 'text-green-400' : 'text-red-400'
                            }`}>
                              {currentLiveBar.open && currentLiveBar.close
                                ? `${((currentLiveBar.close - currentLiveBar.open) / currentLiveBar.open * 100).toFixed(2)}%`
                                : 'N/A'}
                            </td>

                            {/* 11. Avg 20D */}
                            <td className="text-right p-2 text-gray-400 text-sm">
                              {currentLiveBar.avg_20d?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </td>

                            {/* 12. Z-Score — projected_zscore for live */}
                            <td className={`text-right p-2 font-bold text-sm ${zscoreColor(currentLiveBar.projected_zscore)}`}>
                              {currentLiveBar.projected_zscore?.toFixed(2) || 'N/A'}
                            </td>

                            {/* 13. Ratio — est_vol_at_close for live */}
                            <td className="text-right p-2 font-bold text-blue-300 text-sm">
                              {currentLiveBar.est_vol_at_close
                                ? `${(currentLiveBar.est_vol_at_close * 100).toFixed(0)}%`
                                : 'N/A'}
                            </td>

                            {/* 14. Session */}
                            <td className="p-2">
                              <span className={`px-2 py-1 rounded text-xs font-semibold ${
                                currentLiveBar.session === 'RTH'
                                  ? 'bg-green-900 text-green-200'
                                  : 'bg-gray-700 text-gray-300'
                              }`}>
                                {currentLiveBar.session}
                              </span>
                            </td>
                          </tr>
                        )}

                        {/* HISTORICAL ROWS */}
                        {bars.map((bar, idx) => (
                          <tr
                            key={idx}
                            className="border-b border-gray-700 hover:bg-gray-750 transition-colors"
                          >
                            {/* 1. Time */}
                            <td className="p-2 text-xs">
                              {new Date(bar.timestamp).toLocaleString('en-US', {
                                month: 'short', day: 'numeric',
                                hour: '2-digit', minute: '2-digit',
                                timeZone: 'America/New_York'
                              })}
                            </td>

                            {/* 2. Band */}
                            <td className="p-2 font-mono text-sm">{bar.timeband}</td>

                            {/* 3. Volume */}
                            <td className="text-right p-2 font-semibold text-sm">
                              {bar.volume?.toLocaleString()}
                            </td>

                            {/* 4. Agg Buy */}
                            <td className="text-right p-2 text-sm text-green-400">
                              {bar.buy_volume?.toLocaleString() || '-'}
                            </td>

                            {/* 5. Agg Sell */}
                            <td className="text-right p-2 text-sm text-red-400">
                              {bar.sell_volume?.toLocaleString() || '-'}
                            </td>

                            {/* 6. Passive Vol */}
                            <td className="text-right p-2 text-sm text-gray-500">
                              {bar.passive_volume?.toLocaleString() || '-'}
                            </td>

                            {/* 7. Buy-Sell Δ */}
                            <td className={`text-right p-2 font-bold text-sm ${
                              (bar.delta || 0) > 0 ? 'text-green-400'
                                : (bar.delta || 0) < 0 ? 'text-red-400'
                                : 'text-gray-400'
                            }`}>
                              {bar.delta !== null && bar.delta !== undefined
                                ? (bar.delta >= 0 ? '+' : '') + bar.delta.toLocaleString()
                                : '-'}
                            </td>

                            {/* 8. B-S Δ % */}
                            <td className={`text-right p-2 text-sm ${deltaPctColor(bar.delta_pct)}`}>
                              {bar.delta_pct !== null && bar.delta_pct !== undefined
                                ? (() => {
                                    const pct = bar.delta_pct
                                      ? bar.delta_pct.toFixed(1)
                                      : bar.buy_volume && bar.sell_volume
                                        ? ((bar.delta / (bar.buy_volume + bar.sell_volume)) * 100).toFixed(1)
                                        : '0'
                                    return `${pct}%`
                                  })()
                                : '-'}
                            </td>

                            {/* 9. Pressure — threshold coloring */}
                            <td className={`text-right p-2 text-sm ${pressureColor(bar.pressure_ratio)}`}>
                              {bar.pressure_ratio !== null && bar.pressure_ratio !== undefined
                                ? bar.pressure_ratio.toFixed(2)
                                : '-'}
                            </td>

                            {/* 10. % Chg */}
                            <td className={`text-right p-2 text-sm ${
                              ((bar.close - bar.open) / bar.open * 100) >= 0
                                ? 'text-green-400' : 'text-red-400'
                            }`}>
                              {bar.open && bar.close
                                ? `${((bar.close - bar.open) / bar.open * 100).toFixed(2)}%`
                                : '-'}
                            </td>

                            {/* 11. Avg 20D */}
                            <td className="text-right p-2 text-sm text-gray-400">
                              {bar.avg_20d?.toLocaleString(undefined, { maximumFractionDigits: 0 }) || '-'}
                            </td>

                            {/* 12. Z-Score — zscore_20d for historical */}
                            <td className={`text-right p-2 text-sm ${zscoreColor(bar.zscore_20d)}`}>
                              {bar.zscore_20d?.toFixed(2) || '-'}
                            </td>

                            {/* 13. Ratio — ratio_to_avg_20d for historical */}
                            <td className="text-right p-2 text-sm">
                              {bar.ratio_to_avg_20d
                                ? `${(bar.ratio_to_avg_20d * 100).toFixed(0)}%`
                                : 'N/A'}
                            </td>

                            {/* 14. Session */}
                            <td className="p-2">
                              <span className={`px-2 py-1 rounded text-xs font-semibold ${
                                bar.session === 'RTH'
                                  ? 'bg-green-900 text-green-200'
                                  : 'bg-gray-700 text-gray-300'
                              }`}>
                                {bar.session}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })}

            {/* ── Historical Combined Table ── */}
            <div className="bg-gray-800 rounded-lg shadow-xl p-6 mt-12">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-2xl font-bold">Historical Data — All Bars</h2>
                <div className="flex gap-4 items-center">
                  <select
                    value={selectedTicker}
                    onChange={(e) => setSelectedTicker(e.target.value)}
                    className="bg-gray-700 text-white px-4 py-2 rounded"
                  >
                    <option value="All">All Tickers</option>
                    {tickers.map(ticker => (
                      <option key={ticker} value={ticker}>{ticker}</option>
                    ))}
                  </select>

                  <select
                    value={historicalDays}
                    onChange={(e) => setHistoricalDays(parseInt(e.target.value))}
                    className="bg-gray-700 text-white px-4 py-2 rounded"
                  >
                    <option value="1">Last 1 Day</option>
                    <option value="5">Last 5 Days</option>
                    <option value="10">Last 10 Days</option>
                    <option value="20">Last 20 Days</option>
                  </select>

                  <button
                    onClick={() => downloadCSV(
                      historicalData,
                      `${selectedTicker}_${historicalDays}days_${new Date().toISOString().split('T')[0]}.csv`
                    )}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded font-semibold"
                  >
                    Download CSV
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto overflow-y-auto max-h-[600px] scroll-hover-table rounded-lg">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-800 z-10">
                    <tr className="border-b border-gray-700">
                      <th className="text-left p-2 text-gray-400 text-xs">Timestamp</th>
                      <th className="text-left p-2 text-gray-400 text-xs">Ticker</th>
                      <th className="text-left p-2 text-gray-400 text-xs">Timeband</th>
                      <th className="text-right p-2 text-gray-400 text-xs">Open</th>
                      <th className="text-right p-2 text-gray-400 text-xs">High</th>
                      <th className="text-right p-2 text-gray-400 text-xs">Low</th>
                      <th className="text-right p-2 text-gray-400 text-xs">Close</th>
                      <th className="text-right p-2 text-gray-400 text-xs">% Chg</th>
                      <th className="text-right p-2 text-gray-400 text-xs">Volume</th>
                      <th className="text-right p-2 text-gray-400 text-xs">Agg Buy</th>
                      <th className="text-right p-2 text-gray-400 text-xs">Agg Sell</th>
                      <th className="text-right p-2 text-gray-400 text-xs">Passive Vol</th>
                      <th className="text-right p-2 text-gray-400 text-xs">Buy-Sell Δ</th>
                      <th className="text-right p-2 text-gray-400 text-xs">B-S Δ %</th>
                      <th className="text-right p-2 text-gray-400 text-xs">Pressure</th>
                      <th className="text-right p-2 text-gray-400 text-xs">Avg 20D</th>
                      <th className="text-right p-2 text-gray-400 text-xs">Z-Score</th>
                      <th className="text-right p-2 text-gray-400 text-xs">Ratio</th>
                      <th className="text-left p-2 text-gray-400 text-xs">Session</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historicalData.map((bar, idx) => (
                      <tr
                        key={idx}
                        className={`border-b hover:bg-gray-750 transition-colors ${
                          bar.isLive ? 'bg-blue-950 border-blue-700' : 'border-gray-700'
                        }`}
                      >
                        {/* Timestamp — LIVE rows show pulsing dot just like per-ticker tables */}
                        <td className="p-2 text-xs">
                          {bar.isLive ? (
                            <div className="flex items-center gap-2 font-bold">
                              <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse flex-shrink-0"></span>
                              LIVE
                            </div>
                          ) : (
                            new Date(bar.timestamp).toLocaleString('en-US', {
                              month: 'short', day: 'numeric',
                              hour: '2-digit', minute: '2-digit',
                              timeZone: 'America/New_York'
                            })
                          )}
                        </td>

                        {/* Ticker */}
                        <td className="p-2 text-xs font-semibold">{bar.ticker}</td>

                        {/* Timeband */}
                        <td className={`p-2 font-mono text-xs ${bar.isLive ? 'font-bold' : ''}`}>
                          {bar.timeband}
                        </td>

                        {/* Open */}
                        <td className="text-right p-2 text-xs">{bar.open?.toFixed(2) || '-'}</td>

                        {/* High */}
                        <td className="text-right p-2 text-xs text-green-400">{bar.high?.toFixed(2) || '-'}</td>

                        {/* Low */}
                        <td className="text-right p-2 text-xs text-red-400">{bar.low?.toFixed(2) || '-'}</td>

                        {/* Close */}
                        <td className="text-right p-2 text-xs font-semibold">{bar.close?.toFixed(2) || '-'}</td>

                        {/* % Chg */}
                        <td className={`text-right p-2 text-xs ${
                          ((bar.close - bar.open) / bar.open * 100) >= 0 ? 'text-green-400' : 'text-red-400'
                        }`}>
                          {bar.open && bar.close
                            ? `${((bar.close - bar.open) / bar.open * 100).toFixed(2)}%`
                            : '-'}
                        </td>

                        {/* Volume */}
                        <td className={`text-right p-2 text-xs font-semibold ${bar.isLive ? 'text-blue-300' : ''}`}>
                          {bar.volume?.toLocaleString()}
                        </td>

                        {/* Agg Buy */}
                        <td className="text-right p-2 text-xs text-green-400">
                          {bar.buy_volume?.toLocaleString() || '-'}
                        </td>

                        {/* Agg Sell */}
                        <td className="text-right p-2 text-xs text-red-400">
                          {bar.sell_volume?.toLocaleString() || '-'}
                        </td>

                        {/* Passive Vol */}
                        <td className="text-right p-2 text-xs text-gray-500">
                          {bar.passive_volume?.toLocaleString() || '-'}
                        </td>

                        {/* Buy-Sell Δ */}
                        <td className={`text-right p-2 text-xs ${
                          (bar.delta || 0) > 0 ? 'text-green-400'
                            : (bar.delta || 0) < 0 ? 'text-red-400'
                            : 'text-gray-400'
                        }`}>
                          {bar.delta !== null && bar.delta !== undefined
                            ? (bar.delta >= 0 ? '+' : '') + bar.delta.toLocaleString()
                            : '-'}
                        </td>

                        {/* B-S Δ % */}
                        <td className={`text-right p-2 text-xs ${deltaPctColor(bar.delta_pct)}`}>
                          {bar.delta_pct != null ? `${bar.delta_pct.toFixed(1)}%` : '-'}
                        </td>

                        {/* Pressure — threshold coloring */}
                        <td className={`text-right p-2 text-xs ${pressureColor(bar.pressure_ratio)}`}>
                          {bar.pressure_ratio != null ? bar.pressure_ratio.toFixed(2) : '-'}
                        </td>

                        {/* Avg 20D */}
                        <td className="text-right p-2 text-xs text-gray-400">
                          {bar.avg_20d?.toLocaleString(undefined, { maximumFractionDigits: 0 }) || '-'}
                        </td>

                        {/* Z-Score — projected for live, zscore_20d for historical */}
                        <td className={`text-right p-2 text-xs ${
                          zscoreColor(bar.isLive ? bar.projected_zscore : bar.zscore_20d)
                        }`}>
                          {bar.isLive
                            ? (bar.projected_zscore?.toFixed(2) || '-')
                            : (bar.zscore_20d?.toFixed(2) || '-')}
                        </td>

                        {/* Ratio — est_vol_at_close for live, ratio_to_avg_20d for historical */}
                        <td className={`text-right p-2 text-xs ${bar.isLive ? 'text-blue-300 font-bold' : ''}`}>
                          {bar.isLive
                            ? (bar.est_vol_at_close ? `${(bar.est_vol_at_close * 100).toFixed(0)}%` : '-')
                            : (bar.ratio_to_avg_20d ? `${(bar.ratio_to_avg_20d * 100).toFixed(0)}%` : '-')}
                        </td>

                        {/* Session */}
                        <td className="p-2">
                          <span className={`px-2 py-1 rounded text-xs font-semibold ${
                            bar.session === 'RTH' ? 'bg-green-900 text-green-200' : 'bg-gray-700 text-gray-300'
                          }`}>
                            {bar.session}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 text-sm text-gray-400">
                Showing {historicalData.length} bars for {selectedTicker === 'All' ? 'all tickers' : selectedTicker} over the last {historicalDays} day{historicalDays !== 1 ? 's' : ''}
              </div>
            </div>
          </>
        )}

        {/* ════════════════════════════════════════
            GAP ANALYSIS TAB
        ════════════════════════════════════════ */}
        {activeTab === 'gaps' && (
          <div className="space-y-10">

            {/* Full-data loading indicator */}
            {fullGapLoading && (
              <div className="flex items-center gap-3 text-gray-400 text-sm">
                <svg className="animate-spin h-4 w-4 text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                Loading full gap dataset for stat tables…
              </div>
            )}

            {/* ── Table 1: Unhit Targets ── */}
            <div className="bg-gray-800 rounded-lg shadow-xl p-6">
              <div className="flex justify-between items-start mb-4">
                <GapSectionHeader
                  title="Unhit Targets — Last 10 Trading Days (Volume Regimes)"
                  caption="Open gaps where the previous close has not yet been revisited"
                />
                <button onClick={() => downloadCSV(unhitTargets, 'unhit_targets.csv')} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm font-semibold shrink-0 ml-4">CSV</button>
              </div>
              <UnhitTargetsTable data={unhitTargets} bucketColor={volBucketColor} typeColor={gapTypeColor} />
            </div>

            {/* ── Table 2: Gap Close Prob (simple) ── */}
            <div className="bg-gray-800 rounded-lg shadow-xl p-6">
              <div className="flex justify-between items-start mb-4">
                <GapSectionHeader
                  title="Gap Close Probability by Day (Cumulative)"
                  caption="Decimal probability that a gap has closed on or before day N — all history"
                />
                <button onClick={() => downloadCSV(gapCloseProb, 'gap_close_prob.csv')} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm font-semibold shrink-0 ml-4">CSV</button>
              </div>
              <GapCloseProbTable data={gapCloseProb} typeColor={gapTypeColor} />
            </div>

            {/* ── Table 3: Gap Close Prob (Volume Regimes) ── */}
            <div className="bg-gray-800 rounded-lg shadow-xl p-6">
              <div className="flex justify-between items-start mb-4">
                <GapSectionHeader
                  title="Gap Close Probability by Day (Cumulative — Volume Regimes)"
                  caption="Cumulative probability conditioned on volume regime — post-2009, top 9 regimes by frequency"
                />
                <button onClick={() => downloadCSV(regimeCloseProb, 'regime_close_prob.csv')} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm font-semibold shrink-0 ml-4">CSV</button>
              </div>
              <RegimeCloseProbTable data={regimeCloseProb} />
            </div>

            {/* ── Table 4: Days to Target Stats ── */}
            <div className="bg-gray-800 rounded-lg shadow-xl p-6">
              <div className="flex justify-between items-start mb-4">
                <GapSectionHeader
                  title="Days to Target Stats (Last 250 per Gap Type)"
                  caption="Rolling distributional stats for how many calendar days until the gap fills"
                />
                <button onClick={() => downloadCSV(daysToTargetStats, 'days_to_target_stats.csv')} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm font-semibold shrink-0 ml-4">CSV</button>
              </div>
              <DistStatsTable data={daysToTargetStats} typeColor={gapTypeColor} />
            </div>

            {/* ── Table 5: MAM Stats in Days ── */}
            <div className="bg-gray-800 rounded-lg shadow-xl p-6">
              <div className="flex justify-between items-start mb-4">
                <GapSectionHeader
                  title="MAM Stats in Days (Last 250 per Gap Type)"
                  caption="How many days until the maximum adverse move is reached"
                />
                <button onClick={() => downloadCSV(mamDaysStats, 'mam_days_stats.csv')} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm font-semibold shrink-0 ml-4">CSV</button>
              </div>
              <DistStatsTable data={mamDaysStats} typeColor={gapTypeColor} />
            </div>

            {/* ── Table 6: MAM Stats in Points ── */}
            <div className="bg-gray-800 rounded-lg shadow-xl p-6">
              <div className="flex justify-between items-start mb-4">
                <GapSectionHeader
                  title="MAM Stats in Points (Last 250 per Gap Type)"
                  caption="Dollar magnitude of the maximum adverse move"
                />
                <button onClick={() => downloadCSV(mamPtsStats, 'mam_pts_stats.csv')} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-sm font-semibold shrink-0 ml-4">CSV</button>
              </div>
              <DistStatsTable data={mamPtsStats} prefix="$" typeColor={gapTypeColor} />
            </div>

            {/* ── Raw Gap Data (existing table, date-filtered) ── */}
            <div className="bg-gray-800 rounded-lg shadow-xl p-6">
              <div className="flex justify-between items-center mb-6 flex-wrap gap-4">
                <h2 className="text-2xl font-bold">SPY Gap Analysis — Raw Data</h2>
                <div className="flex gap-4 items-center flex-wrap">
                  <div className="flex gap-2 items-center">
                    <label className="text-gray-400 text-sm">Show last:</label>
                    <select
                      value={gapDaysFilter}
                      onChange={e => setGapDaysFilter(Number(e.target.value))}
                      className="bg-gray-700 text-white px-3 py-1 rounded text-sm"
                    >
                      {[10, 30, 60, 90, 180, 365].map(d => (
                        <option key={d} value={d}>{d} days</option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={() => downloadCSV(gapData, `spy_gaps_${new Date().toISOString().split('T')[0]}.csv`)}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded font-semibold text-sm"
                  >
                    Download CSV
                  </button>
                </div>
              </div>

              {gapLoading ? (
                <p className="text-gray-400">Loading gap data...</p>
              ) : (
                <div className="bg-gray-800 rounded-lg">
                  <div className="overflow-x-auto overflow-y-auto max-h-[700px] rounded-lg">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-gray-800 z-10">
                        <tr className="border-b border-gray-700">
                          <th className="text-left p-2 text-gray-400 text-xs">Date</th>
                          <th className="text-left p-2 text-gray-400 text-xs">DOW</th>
                          <th className="text-left p-2 text-gray-400 text-xs">Gap Type</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Prev Close</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Open</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Gap $</th>
                          <th className="text-left p-2 text-gray-400 text-xs">Direction</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Days to Target</th>
                          <th className="text-left p-2 text-gray-400 text-xs">Target Date</th>
                          <th className="text-left p-2 text-gray-400 text-xs">Vol Regime</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Rel Vol</th>
                          <th className="text-right p-2 text-gray-400 text-xs">MAM $</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Days to MAM</th>
                          <th className="text-right p-2 text-gray-400 text-xs">MAM 10D $</th>
                          <th className="text-left p-2 text-gray-400 text-xs">Day Move</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gapData.map((row, idx) => (
                          <tr key={idx} className="border-b border-gray-700 hover:bg-gray-750 transition-colors">
                            <td className="p-2 text-xs font-mono">{row.date}</td>
                            <td className="p-2 text-xs text-gray-400">{row.dow}</td>
                            <td className={`p-2 text-xs font-semibold ${gapTypeColor(row.gap_type)}`}>
                              {row.gap_type || '-'}
                            </td>
                            <td className="text-right p-2 text-xs">{row.previous_close?.toFixed(2) ?? '-'}</td>
                            <td className="text-right p-2 text-xs">{row.open?.toFixed(2) ?? '-'}</td>
                            <td className="text-right p-2 text-xs font-semibold">
                              {row.gap_value !== null ? `$${row.gap_value?.toFixed(2)}` : '-'}
                            </td>
                            <td className="p-2">
                              {row.trade_direction && row.trade_direction !== 'not tradable' ? (
                                <span className={`px-2 py-1 rounded text-xs font-semibold ${
                                  row.trade_direction === 'long'
                                    ? 'bg-green-900 text-green-200'
                                    : 'bg-red-900 text-red-200'
                                }`}>
                                  {row.trade_direction}
                                </span>
                              ) : (
                                <span className="text-gray-600 text-xs">—</span>
                              )}
                            </td>
                            <td className="text-right p-2 text-xs">
                              {row.days_to_target !== null
                                ? row.days_to_target
                                : <span className="text-gray-600">unfilled</span>}
                            </td>
                            <td className="p-2 text-xs text-gray-400 font-mono">{row.target_achieved_date ?? '—'}</td>
                            <td className="p-2">
                              {row.rel_vol_bucket ? (
                                <span className={`px-2 py-1 rounded text-xs font-semibold ${volBucketColor(row.rel_vol_bucket)}`}>
                                  {row.rel_vol_bucket}
                                </span>
                              ) : '-'}
                            </td>
                            <td className="text-right p-2 text-xs text-gray-300">
                              {row.rel_vol_20 !== null ? row.rel_vol_20?.toFixed(2) : '-'}
                            </td>
                            <td className="text-right p-2 text-xs text-yellow-400 font-semibold">
                              {row.max_adverse_move !== null && row.max_adverse_move !== 0
                                ? `$${row.max_adverse_move?.toFixed(2)}`
                                : '-'}
                            </td>
                            <td className="text-right p-2 text-xs text-gray-300">
                              {row.days_to_mam !== null && row.days_to_mam !== 0 ? row.days_to_mam : '-'}
                            </td>
                            <td className="text-right p-2 text-xs text-orange-400">
                              {row.mam_10d_pts !== null && row.mam_10d_pts !== 0
                                ? `$${row.mam_10d_pts?.toFixed(2)}`
                                : '-'}
                            </td>
                            <td className="p-2">
                              {row.same_day_move_type && row.same_day_move_type !== 'none' ? (
                                <span className={`px-2 py-1 rounded text-xs font-semibold ${
                                  row.same_day_move_type === 'green'
                                    ? 'bg-green-900 text-green-200'
                                    : 'bg-red-900 text-red-200'
                                }`}>
                                  {row.same_day_move_type}
                                </span>
                              ) : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-gray-500 text-xs mt-3">
                    {gapData.length} rows — last {gapDaysFilter} days
                  </p>
                </div>
              )}
            </div>

          </div>
        )}

        {/* ════════════════════════════════════════
            OPTIONS TAB
        ════════════════════════════════════════ */}
        {activeTab === 'options' && (
          <div>
            {optionsLoading && !oiData.length ? (
              <p className="text-gray-400">Loading options data...</p>
            ) : (
              <>
                {/* ── Summary Stats ── */}
                {(() => {
                  const spot = greeksData[0]?.spot
                  const totalCallOI = oiData.filter(r => r.side === 'C').reduce((s, r) => s + (r.open_interest || 0), 0)
                  const totalPutOI  = oiData.filter(r => r.side === 'P').reduce((s, r) => s + (r.open_interest || 0), 0)
                  const pcRatio = totalCallOI > 0 ? (totalPutOI / totalCallOI).toFixed(3) : '—'
                  const lastTs = greeksData[0] ? new Date(greeksData[0].timestamp ?? '').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) : '—'
                  const expiries = [...new Set(oiData.map(r => r.expiration))].sort()
                  const spot2 = allGreeksData[0]?.spot

                  return (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
                        {[
                          { label: 'Spot', value: spot ? `$${spot.toFixed(2)}` : '—', color: 'text-white' },
                          { label: 'Total Call OI', value: totalCallOI.toLocaleString(), color: 'text-red-400' },
                          { label: 'Total Put OI',  value: totalPutOI.toLocaleString(),  color: 'text-green-400' },
                          { label: 'P/C Ratio',     value: pcRatio, color: Number(pcRatio) > 1.2 ? 'text-green-400' : Number(pcRatio) < 0.8 ? 'text-red-400' : 'text-yellow-400' },
                          { label: 'Greeks Snapshot', value: lastTs, color: 'text-blue-400' },
                        ].map(({ label, value, color }) => (
                          <div key={label} className="bg-gray-800 rounded-lg p-4">
                            <p className="text-gray-400 text-xs mb-1">{label}</p>
                            <p className={`text-xl font-bold ${color}`}>{value}</p>
                          </div>
                        ))}
                      </div>

                      {/* ── Dealer Exposure Charts ── */}
                      {(() => {
                        const nearStrikes = exposureChartData.filter(r =>
                          spot2 && Math.abs(r.strike - spot2) <= 20
                        )
                        const chartData = nearStrikes.length >= 5 ? nearStrikes : exposureChartData

                        return (
                          <div className="mb-8">
                            <h2 className="text-xl font-bold mb-1">Dealer Exposure Charts</h2>
                            <p className="text-gray-400 text-sm mb-6">Computed from live greeks × OI. Spot ±20 strikes shown.</p>
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                              <DealerChart
                                title="Gamma Exposure (GEX)"
                                caption="sensitivity of dealer delta to underlying price changes (×1M)"
                                chartData={chartData} spot={spot2}
                                config={{
                                  legend: true,
                                  tooltipFmt: (v, l) => `${l}: ${v?.toFixed(3)}M`,
                                  datasets: [
                                    { key: 'callGEX',  label: 'Call GEX', color: '#ef4444' },
                                    { key: 'putGEX',   label: 'Put GEX',  color: '#22c55e' },
                                  ]
                                }}
                              />

                              <DealerChart
                                title="Net GEX by Strike"
                                caption="positive = dealers long gamma, suppresses moves (×1M)"
                                chartData={chartData} spot={spot2}
                                config={{
                                  tooltipFmt: (v) => `Net GEX: ${v?.toFixed(3)}M`,
                                  datasets: [
                                    { key: 'netGEX', label: 'Net GEX', color: v => v >= 0 ? '#f9a8d4' : '#6ee7b7' },
                                  ]
                                }}
                              />

                              <DealerChart
                                title="Dealer Delta Exposure"
                                caption="inverted from client side — green = dealers long delta (×1M)"
                                chartData={chartData} spot={spot2}
                                config={{
                                  tooltipFmt: (v) => `Dealer Δ: ${v?.toFixed(3)}M`,
                                  datasets: [
                                    { key: 'dealerDelta', label: 'Dealer Δ', color: v => v >= 0 ? '#4ade80' : '#f87171' },
                                  ]
                                }}
                              />

                              <DealerChart
                                title="Open Interest by Strike"
                                caption="calls (red) vs puts (green) — high OI = pinning magnet"
                                chartData={chartData} spot={spot2}
                                config={{
                                  legend: true,
                                  tooltipFmt: (v, l) => `${l}: ${v?.toLocaleString()}`,
                                  yFmt: v => (v / 1000).toFixed(0) + 'k',
                                  datasets: [
                                    { key: 'callOI', label: 'Call OI', color: 'rgba(239,68,68,0.8)' },
                                    { key: 'putOI',  label: 'Put OI',  color: 'rgba(34,197,94,0.8)' },
                                  ]
                                }}
                              />

                              <DealerChart
                                title="Dealer Vega Exposure"
                                caption="negative = dealers short vol, buying pressure raises IV (×1M)"
                                chartData={chartData} spot={spot2}
                                config={{
                                  tooltipFmt: (v) => `Net Vega: ${v?.toFixed(3)}M`,
                                  datasets: [
                                    { key: 'netVega', label: 'Net Vega', color: v => v >= 0 ? '#a78bfa' : '#c4b5fd' },
                                  ]
                                }}
                              />

                              <DealerChart
                                title="Dealer Theta Exposure"
                                caption="negative = dealers paying theta, time decay works against them (×1M)"
                                chartData={chartData} spot={spot2}
                                config={{
                                  tooltipFmt: (v) => `Net Theta: ${v?.toFixed(3)}M`,
                                  datasets: [
                                    { key: 'netTheta', label: 'Net Theta', color: v => v >= 0 ? '#fb923c' : '#fed7aa' },
                                  ]
                                }}
                              />

                            </div>
                          </div>
                        )
                      })()}

                      {/* ── Filters ── */}
                      <div className="flex gap-4 mb-6 items-center flex-wrap">
                        <div className="flex gap-2 items-center">
                          <label className="text-gray-400 text-sm">Side:</label>
                          {['all', 'C', 'P'].map(s => (
                            <button key={s}
                              onClick={() => setOptionsSide(s)}
                              className={`px-3 py-1 rounded text-xs font-semibold ${optionsSide === s ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
                            >{s === 'all' ? 'All' : s === 'C' ? 'Calls' : 'Puts'}</button>
                          ))}
                        </div>
                        <div className="flex gap-2 items-center">
                          <label className="text-gray-400 text-sm">Expiry:</label>
                          <select
                            value={optionsExpiry}
                            onChange={e => setOptionsExpiry(e.target.value)}
                            className="bg-gray-700 text-white px-3 py-1 rounded text-sm"
                          >
                            <option value="all">All</option>
                            {expiries.map(e => <option key={e} value={e}>{e}</option>)}
                          </select>
                        </div>
                        <button
                          onClick={() => downloadCSV(oiData, `spy_oi_${new Date().toISOString().split('T')[0]}.csv`)}
                          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded font-semibold text-sm ml-auto"
                        >Download OI CSV</button>
                      </div>
                    </>
                  )
                })()}

                {/* ── OI Table ── */}
                <div className="bg-gray-800 rounded-lg shadow-xl p-6 mb-8">
                  <h2 className="text-xl font-bold mb-4">Open Interest by Strike — Today's Snapshot</h2>
                  <div className="overflow-x-auto overflow-y-auto max-h-[500px] rounded-lg">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-gray-800 z-10">
                        <tr className="border-b border-gray-700">
                          <th className="text-left p-2 text-gray-400 text-xs">Expiry</th>
                          <th className="text-right p-2 text-gray-400 text-xs">DTE</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Strike</th>
                          <th className="text-left p-2 text-gray-400 text-xs">Side</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Open Interest</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Prev Close</th>
                        </tr>
                      </thead>
                      <tbody>
                        {oiData
                          .filter(r => optionsSide === 'all' || r.side === optionsSide)
                          .filter(r => optionsExpiry === 'all' || r.expiration === optionsExpiry)
                          .map((row, idx) => (
                          <tr key={idx} className="border-b border-gray-700 hover:bg-gray-750 transition-colors">
                            <td className="p-2 text-xs font-mono">{row.expiration}</td>
                            <td className="text-right p-2 text-xs text-gray-400">{row.dte_trading}</td>
                            <td className="text-right p-2 text-xs font-semibold">${row.strike?.toFixed(0)}</td>
                            <td className="p-2">
                              <span className={`px-2 py-0.5 rounded text-xs font-semibold ${row.side === 'C' ? 'bg-red-900 text-red-200' : 'bg-green-900 text-green-200'}`}>
                                {row.side === 'C' ? 'Call' : 'Put'}
                              </span>
                            </td>
                            <td className="text-right p-2 text-xs font-bold text-yellow-300">
                              {row.open_interest?.toLocaleString()}
                            </td>
                            <td className="text-right p-2 text-xs text-gray-300">
                              {row.prev_close ? `$${row.prev_close.toFixed(2)}` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-gray-500 text-xs mt-3">
                    {oiData.filter(r => optionsSide === 'all' || r.side === optionsSide).filter(r => optionsExpiry === 'all' || r.expiration === optionsExpiry).length} contracts shown, sorted by OI desc
                  </p>
                </div>

                {/* ── Latest Greeks Snapshot ── */}
                <div className="bg-gray-800 rounded-lg shadow-xl p-6">
                  <h2 className="text-xl font-bold mb-4">Latest Greeks Snapshot — Top by Ask Gamma</h2>
                  <div className="overflow-x-auto overflow-y-auto max-h-[500px] rounded-lg">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-gray-800 z-10">
                        <tr className="border-b border-gray-700">
                          <th className="text-left p-2 text-gray-400 text-xs">Expiry</th>
                          <th className="text-right p-2 text-gray-400 text-xs">DTE</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Strike</th>
                          <th className="text-left p-2 text-gray-400 text-xs">Side</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Bid</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Ask</th>
                          <th className="text-right p-2 text-gray-400 text-xs">IV</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Delta</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Gamma</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Theta</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Vega</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Ask Gamma</th>
                          <th className="text-right p-2 text-gray-400 text-xs">Volume</th>
                        </tr>
                      </thead>
                      <tbody>
                        {greeksData
                          .filter(r => optionsSide === 'all' || r.side === optionsSide)
                          .filter(r => optionsExpiry === 'all' || r.expiration === optionsExpiry)
                          .map((row, idx) => (
                          <tr key={idx} className="border-b border-gray-700 hover:bg-gray-750 transition-colors">
                            <td className="p-2 text-xs font-mono">{row.expiration}</td>
                            <td className="text-right p-2 text-xs text-gray-400">{row.dte_trading}</td>
                            <td className="text-right p-2 text-xs font-semibold">${row.strike?.toFixed(0)}</td>
                            <td className="p-2">
                              <span className={`px-2 py-0.5 rounded text-xs font-semibold ${row.side === 'C' ? 'bg-red-900 text-red-200' : 'bg-green-900 text-green-200'}`}>
                                {row.side === 'C' ? 'Call' : 'Put'}
                              </span>
                            </td>
                            <td className="text-right p-2 text-xs">{row.bid ? `$${row.bid.toFixed(2)}` : '—'}</td>
                            <td className="text-right p-2 text-xs">{row.ask ? `$${row.ask.toFixed(2)}` : '—'}</td>
                            <td className="text-right p-2 text-xs text-blue-300">
                              {row.iv ? `${(row.iv * 100).toFixed(1)}%` : '—'}
                            </td>
                            <td className={`text-right p-2 text-xs ${(row.delta || 0) > 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {row.delta?.toFixed(3) ?? '—'}
                            </td>
                            <td className="text-right p-2 text-xs text-yellow-300">
                              {row.gamma?.toFixed(4) ?? '—'}
                            </td>
                            <td className="text-right p-2 text-xs text-orange-300">
                              {row.theta?.toFixed(4) ?? '—'}
                            </td>
                            <td className="text-right p-2 text-xs text-purple-300">
                              {row.vega?.toFixed(4) ?? '—'}
                            </td>
                            <td className="text-right p-2 text-xs font-bold text-orange-300">
                              {row.ask_gamma?.toFixed(4) ?? '—'}
                            </td>
                            <td className="text-right p-2 text-xs text-gray-300">
                              {row.volume?.toLocaleString() ?? '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-gray-500 text-xs mt-3">
                    {greeksData.filter(r => optionsSide === 'all' || r.side === optionsSide).length} contracts — live streaming, updates every ~5s
                  </p>
                </div>
              </>
            )}
          </div>
        )}

      </div>
    </div>
  )
}