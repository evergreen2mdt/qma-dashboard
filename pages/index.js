import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export default function Index() {
  const tickers = ['SPY', 'ES', 'MES']

  const [barsByTicker, setBarsByTicker] = useState({})
  const [liveBars, setLiveBars] = useState([])
  const [historicalData, setHistoricalData] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab] = useState('volume')
  const [selectedTicker, setSelectedTicker] = useState('SPY')
  const [historicalDays, setHistoricalDays] = useState(1)

  // CSV Download Function
  function downloadCSV(data, filename) {
    if (!data || data.length === 0) return

    const headers = Object.keys(data[0])
    const csvContent = [
      headers.join(','),
      ...data.map(row => 
        headers.map(header => {
          const value = row[header]
          if (value === null || value === undefined) return ''
          if (typeof value === 'string' && value.includes(',')) {
            return `"${value}"`
          }
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

  // Add inline styles for expand-on-hover
  const hoverStyles = `
    <style>
      .scroll-hover-table {
        transition: max-height 0.3s ease-in-out;
      }
      .scroll-hover-table:hover {
        max-height: 800px !important;
      }
    </style>
  `

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5000)
    return () => clearInterval(interval)
  }, [selectedTicker, historicalDays])

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

      if (liveError && liveError.code !== 'PGRST116') {
        throw liveError
      }

      // Fetch historical data for selected ticker
      const daysAgo = new Date()
      daysAgo.setDate(daysAgo.getDate() - historicalDays)

      let historicalQuery = supabase
        .from('bars_30m')
        .select('*')
        .gte('timestamp', daysAgo.toISOString())
        .order('timestamp', { ascending: false })

      // Only filter by ticker if not "All"
      if (selectedTicker !== 'All') {
        historicalQuery = historicalQuery.eq('ticker', selectedTicker)
      }

      const { data: historical, error: historicalError } = await historicalQuery

      if (historicalError) throw historicalError

      // Custom sort: timestamp (desc), then ticker in SPY, ES, MES order
      const tickerOrder = { 'SPY': 1, 'ES': 2, 'MES': 3 }
      
      // Merge live bars with historical bars
      let allBars = [...(historical || [])]
      
      // Add live bars if "All" is selected or if ticker matches
      if (live && live.length > 0) {
        const filteredLiveBars = selectedTicker === 'All' 
          ? live 
          : live.filter(bar => bar.ticker === selectedTicker)
        
        // Mark live bars so we can style them differently
        const markedLiveBars = filteredLiveBars.map(bar => ({
          ...bar,
          isLive: true
        }))
        
        allBars = [...markedLiveBars, ...allBars]
      }
      
      const sortedHistorical = allBars.sort((a, b) => {
        // First by timestamp (descending)
        if (a.timestamp !== b.timestamp) {
          return new Date(b.timestamp) - new Date(a.timestamp)
        }
        // Then by custom ticker order
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
        {/* Inject hover styles */}
        <div dangerouslySetInnerHTML={{ __html: hoverStyles }} />

        <div className="mb-6">
          <h1 className="text-4xl font-bold mb-2">Trading Dashboard</h1>
          <p className="text-gray-400">
            Timeband-based volume analytics + order flow
          </p>
        </div>

        {activeTab === 'volume' && (
          <>
            {tickers.map(ticker => {
              const bars = barsByTicker[ticker] || []
              const currentLiveBar = liveBars.find(b => b.ticker === ticker)

              return (
                <div
                  key={ticker}
                  className="bg-gray-800 rounded-lg shadow-xl p-6 mb-12"
                >
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="text-2xl font-bold">
                      Recent Bars — {ticker}
                    </h2>
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
                          <th className="text-right p-2 text-gray-400 text-sm">Aggression</th>
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
                            {/* 1. Time */}
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
                            <td className="text-right p-2 text-sm">
                              {currentLiveBar.buy_volume?.toLocaleString() || '-'}
                            </td>

                            {/* 5. Agg Sell */}
                            <td className="text-right p-2 text-sm">
                              {currentLiveBar.sell_volume?.toLocaleString() || '-'}
                            </td>

                            {/* 6. Passive Vol */}
                            <td className="text-right p-2 text-sm text-gray-500">
                              {currentLiveBar.passive_volume?.toLocaleString() || '-'}
                            </td>

                            {/* 7. Delta */}
                            <td className={`text-right p-2 font-bold text-sm ${
                              (currentLiveBar.delta || 0) > 0
                                ? 'text-green-400'
                                : (currentLiveBar.delta || 0) < 0
                                  ? 'text-red-400'
                                  : 'text-gray-400'
                            }`}>
                              {currentLiveBar.delta !== null && currentLiveBar.delta !== undefined
                                ? (() => {
                                    const pct = currentLiveBar.delta_pct 
                                      ? currentLiveBar.delta_pct.toFixed(0)
                                      : currentLiveBar.buy_volume && currentLiveBar.sell_volume
                                        ? ((currentLiveBar.delta / (currentLiveBar.buy_volume + currentLiveBar.sell_volume)) * 100).toFixed(0)
                                        : '0'
                                    return `${currentLiveBar.delta.toLocaleString()} (${pct}%)`
                                  })()
                                : '-'}
                            </td>

                            {/* 8. Aggression Ratio */}
                            <td className={`text-right p-2 font-bold text-sm ${
                              (currentLiveBar.aggression_ratio || 0) > 0.55
                                ? 'text-green-400'
                                : (currentLiveBar.aggression_ratio || 0) < 0.45
                                  ? 'text-red-400'
                                  : 'text-gray-400'
                            }`}>
                              {currentLiveBar.aggression_ratio !== null && currentLiveBar.aggression_ratio !== undefined
                                ? `${(currentLiveBar.aggression_ratio * 100).toFixed(0)}%`
                                : '-'}
                            </td>

                            {/* 8. Pressure Ratio */}
                            <td className={`text-right p-2 font-bold text-sm ${
                              (currentLiveBar.pressure_ratio || 0) > 1.2
                                ? 'text-green-400'
                                : (currentLiveBar.pressure_ratio || 0) < 0.8
                                  ? 'text-red-400'
                                  : 'text-gray-400'
                            }`}>
                              {currentLiveBar.pressure_ratio !== null && currentLiveBar.pressure_ratio !== undefined
                                ? currentLiveBar.pressure_ratio.toFixed(2)
                                : '-'}
                            </td>

                            {/* 9. % Chg */}
                            <td className={`text-right p-2 font-bold text-sm ${
                              ((currentLiveBar.close - currentLiveBar.open) /
                                currentLiveBar.open * 100) >= 0
                                ? 'text-green-400'
                                : 'text-red-400'
                            }`}>
                              {currentLiveBar.open && currentLiveBar.close
                                ? `${((currentLiveBar.close - currentLiveBar.open) /
                                    currentLiveBar.open * 100).toFixed(2)}%`
                                : 'N/A'}
                            </td>

                            {/* 10. Avg 20D */}
                            <td className="text-right p-2 text-gray-400 text-sm">
                              {currentLiveBar.avg_20d?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </td>

                            {/* 11. Z-Score */}
                            <td className={`text-right p-2 font-bold text-sm ${
                              Math.abs(currentLiveBar.projected_zscore || 0) > 2
                                ? 'text-red-400'
                                : Math.abs(currentLiveBar.projected_zscore || 0) > 1
                                  ? 'text-yellow-400'
                                  : 'text-green-400'
                            }`}>
                              {currentLiveBar.projected_zscore?.toFixed(2) || 'N/A'}
                            </td>

                            {/* 12. Ratio */}
                            <td className="text-right p-2 font-bold text-blue-300 text-sm">
                              {currentLiveBar.est_vol_at_close
                                ? `${(currentLiveBar.est_vol_at_close * 100).toFixed(0)}%`
                                : 'N/A'}
                            </td>

                            {/* 13. Session */}
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
                              {new Date(bar.timestamp).toLocaleString(
                                'en-US',
                                {
                                  month: 'short',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  timeZone: 'America/New_York'
                                }
                              )}
                            </td>

                            {/* 2. Band */}
                            <td className="p-2 font-mono text-sm">
                              {bar.timeband}
                            </td>

                            {/* 3. Volume */}
                            <td className="text-right p-2 font-semibold text-sm">
                              {bar.volume?.toLocaleString()}
                            </td>

                            {/* 4. Agg Buy */}
                            <td className="text-right p-2 text-sm">
                              {bar.buy_volume?.toLocaleString() || '-'}
                            </td>

                            {/* 5. Agg Sell */}
                            <td className="text-right p-2 text-sm">
                              {bar.sell_volume?.toLocaleString() || '-'}
                            </td>

                            {/* 6. Passive Vol */}
                            <td className="text-right p-2 text-sm text-gray-500">
                              {bar.passive_volume?.toLocaleString() || '-'}
                            </td>

                            {/* 7. Delta */}
                            <td className={`text-right p-2 font-bold text-sm ${
                              (bar.delta || 0) > 0
                                ? 'text-green-400'
                                : (bar.delta || 0) < 0
                                  ? 'text-red-400'
                                  : 'text-gray-400'
                            }`}>
                              {bar.delta !== null && bar.delta !== undefined
                                ? (() => {
                                    const pct = bar.delta_pct 
                                      ? bar.delta_pct.toFixed(0)
                                      : bar.buy_volume && bar.sell_volume
                                        ? ((bar.delta / (bar.buy_volume + bar.sell_volume)) * 100).toFixed(0)
                                        : '0'
                                    return `${bar.delta.toLocaleString()} (${pct}%)`
                                  })()
                                : '-'}
                            </td>

                            {/* 7. Aggression Ratio */}
                            <td className={`text-right p-2 text-sm ${
                              (bar.aggression_ratio || 0) > 0.55
                                ? 'text-green-400'
                                : (bar.aggression_ratio || 0) < 0.45
                                  ? 'text-red-400'
                                  : 'text-gray-400'
                            }`}>
                              {bar.aggression_ratio !== null && bar.aggression_ratio !== undefined
                                ? `${(bar.aggression_ratio * 100).toFixed(0)}%`
                                : '-'}
                            </td>

                            {/* 8. Pressure Ratio */}
                            <td className={`text-right p-2 text-sm ${
                              (bar.pressure_ratio || 0) > 1.2
                                ? 'text-green-400'
                                : (bar.pressure_ratio || 0) < 0.8
                                  ? 'text-red-400'
                                  : 'text-gray-400'
                            }`}>
                              {bar.pressure_ratio !== null && bar.pressure_ratio !== undefined
                                ? bar.pressure_ratio.toFixed(2)
                                : '-'}
                            </td>

                            {/* 9. % Chg */}
                            <td className={`text-right p-2 font-bold text-sm ${
                              ((bar.close - bar.open) / bar.open * 100) >= 0
                                ? 'text-green-400'
                                : 'text-red-400'
                            }`}>
                              {bar.open && bar.close
                                ? `${((bar.close - bar.open) / bar.open * 100).toFixed(2)}%`
                                : 'N/A'}
                            </td>

                            {/* 10. Avg 20D */}
                            <td className="text-right p-2 text-gray-400 text-xs">
                              {bar.avg_20d?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </td>

                            {/* 11. Z-Score */}
                            <td className={`text-right p-2 font-bold text-sm ${
                              Math.abs(bar.zscore_20d || 0) > 2
                                ? 'text-red-400'
                                : Math.abs(bar.zscore_20d || 0) > 1
                                  ? 'text-yellow-400'
                                  : 'text-green-400'
                            }`}>
                              {bar.zscore_20d?.toFixed(2) || 'N/A'}
                            </td>

                            {/* 12. Ratio */}
                            <td className="text-right p-2 text-sm">
                              {bar.ratio_to_avg_20d
                                ? `${(bar.ratio_to_avg_20d * 100).toFixed(0)}%`
                                : 'N/A'}
                            </td>

                            {/* 13. Session */}
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
          </>
        )}

        {/* HISTORICAL DATA TABLE */}
        <div className="bg-gray-800 rounded-lg shadow-xl p-6 mt-12">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold">
              Historical Data — All Bars
            </h2>
            <div className="flex gap-4 items-center">
              {/* Ticker Selector */}
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

              {/* Days Selector */}
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

              {/* Download CSV Button */}
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
                  <th className="text-right p-2 text-gray-400 text-xs">Aggression</th>
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
                      bar.isLive 
                        ? 'border-b-2 border-blue-500 bg-gradient-to-r from-blue-900/40 to-blue-800/40' 
                        : 'border-gray-700'
                    }`}
                  >
                    <td className="p-2 text-xs">
                      {bar.isLive && (
                        <div className="flex items-center gap-1">
                          <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
                          <span className="text-green-400 font-bold text-xs">LIVE</span>
                        </div>
                      )}
                      {new Date(bar.timestamp).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZone: 'America/New_York'
                      })}
                    </td>
                    <td className="p-2 text-xs font-semibold">{bar.ticker}</td>
                    <td className="p-2 text-xs font-mono">{bar.timeband}</td>
                    <td className="text-right p-2 text-xs">{bar.open?.toFixed(2) || '-'}</td>
                    <td className="text-right p-2 text-xs">{bar.high?.toFixed(2) || '-'}</td>
                    <td className="text-right p-2 text-xs">{bar.low?.toFixed(2) || '-'}</td>
                    <td className="text-right p-2 text-xs">{bar.close?.toFixed(2) || '-'}</td>
                    <td className={`text-right p-2 text-xs font-semibold ${
                      bar.open && bar.close 
                        ? ((bar.close - bar.open) / bar.open * 100) > 0 
                          ? 'text-green-400' 
                          : ((bar.close - bar.open) / bar.open * 100) < 0 
                            ? 'text-red-400' 
                            : 'text-gray-400'
                        : 'text-gray-400'
                    }`}>
                      {bar.open && bar.close 
                        ? `${((bar.close - bar.open) / bar.open * 100).toFixed(2)}%` 
                        : '-'
                      }
                    </td>
                    <td className="text-right p-2 text-xs">{bar.volume?.toLocaleString() || '-'}</td>
                    <td className="text-right p-2 text-xs">{bar.buy_volume?.toLocaleString() || '-'}</td>
                    <td className="text-right p-2 text-xs">{bar.sell_volume?.toLocaleString() || '-'}</td>
                    <td className="text-right p-2 text-xs text-gray-500">{bar.passive_volume?.toLocaleString() || '-'}</td>
                    <td className={`text-right p-2 text-xs font-semibold ${
                      (bar.delta || 0) > 0 ? 'text-green-400' : (bar.delta || 0) < 0 ? 'text-red-400' : 'text-gray-400'
                    }`}>
                      {bar.delta?.toLocaleString() || '-'}
                    </td>
                    <td className={`text-right p-2 text-xs ${
                      (bar.delta_pct || 0) > 0 ? 'text-green-400' : (bar.delta_pct || 0) < 0 ? 'text-red-400' : 'text-gray-400'
                    }`}>
                      {bar.delta_pct != null ? `${bar.delta_pct.toFixed(1)}%` : '-'}
                    </td>
                    <td className={`text-right p-2 text-xs ${
                      (bar.aggression_ratio || 0) > 0.55 ? 'text-green-400' : (bar.aggression_ratio || 0) < 0.45 ? 'text-red-400' : 'text-gray-400'
                    }`}>
                      {bar.aggression_ratio != null ? `${(bar.aggression_ratio * 100).toFixed(0)}%` : '-'}
                    </td>
                    <td className={`text-right p-2 text-xs ${
                      (bar.pressure_ratio || 0) > 1.2 ? 'text-green-400' : (bar.pressure_ratio || 0) < 0.8 ? 'text-red-400' : 'text-gray-400'
                    }`}>
                      {bar.pressure_ratio != null ? bar.pressure_ratio.toFixed(2) : '-'}
                    </td>
                    <td className="text-right p-2 text-xs text-gray-400">
                      {bar.avg_20d?.toLocaleString(undefined, { maximumFractionDigits: 0 }) || '-'}
                    </td>
                    <td className={`text-right p-2 text-xs ${
                      Math.abs(bar.zscore_20d || bar.projected_zscore || 0) > 2 ? 'text-red-400' : Math.abs(bar.zscore_20d || bar.projected_zscore || 0) > 1 ? 'text-yellow-400' : 'text-green-400'
                    }`}>
                      {bar.isLive 
                        ? (bar.projected_zscore?.toFixed(2) || '-')
                        : (bar.zscore_20d?.toFixed(2) || '-')
                      }
                    </td>
                    <td className="text-right p-2 text-xs">
                      {bar.isLive
                        ? (bar.est_vol_at_close ? `${(bar.est_vol_at_close * 100).toFixed(0)}%` : '-')
                        : (bar.ratio_to_avg_20d ? `${(bar.ratio_to_avg_20d * 100).toFixed(0)}%` : '-')
                      }
                    </td>
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
      </div>
    </div>
  )
}