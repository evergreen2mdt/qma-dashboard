import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export default function Index() {
  const tickers = ['SPY','ES', 'MES']

  const [barsByTicker, setBarsByTicker] = useState({})
  const [liveBars, setLiveBars] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('volume')

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5000)
    return () => clearInterval(interval)
  }, [])

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

      setBarsByTicker(grouped)
      setLiveBars(live || [])
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
      <div className="max-w-7xl mx-auto">

        <div className="mb-6">
          <h1 className="text-4xl font-bold mb-2">Trading Dashboard</h1>
          <p className="text-gray-400">
            Timeband-based volume analytics
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
                  <h2 className="text-2xl font-bold mb-4">
                    Recent Bars — {ticker}
                  </h2>

                  <div className="overflow-x-auto overflow-y-auto max-h-[500px] scroll-hover-table rounded-lg">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-gray-800 z-10">
                        <tr className="border-b border-gray-700">
                          <th className="text-left p-3 text-gray-400">Time</th>
                          <th className="text-left p-3 text-gray-400">Band</th>
                          <th className="text-right p-3 text-gray-400">Volume</th>
                          <th className="text-right p-3 text-gray-400">Close</th>
                          <th className="text-right p-3 text-gray-400">% Chg</th>
                          <th className="text-right p-3 text-gray-400">Avg 20D</th>
                          <th className="text-right p-3 text-gray-400">Z-Score</th>
                          <th className="text-right p-3 text-gray-400">Ratio</th>
                          <th className="text-left p-3 text-gray-400">Session</th>
                        </tr>
                      </thead>

                      <tbody>

                        {/* LIVE ROW */}
                        {currentLiveBar && (
                          <tr className="border-b-2 border-blue-500 bg-gradient-to-r from-blue-900/40 to-blue-800/40">
                            <td className="p-3 font-bold">
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
                                LIVE
                              </div>
                            </td>

                            <td className="p-3 font-mono font-bold">
                              {currentLiveBar.band || currentLiveBar.timeband}
                            </td>

                            <td className="text-right p-3 font-bold text-blue-300">
                              {currentLiveBar.volume?.toLocaleString()}
                            </td>

                            <td className="text-right p-3 font-bold">
                              {currentLiveBar.close?.toFixed(2)}
                            </td>

                            <td className={`text-right p-3 font-bold ${
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

                            <td className="text-right p-3 text-gray-400">
                              {currentLiveBar.avg_20d?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </td>

                            <td className={`text-right p-3 font-bold ${
                              Math.abs(currentLiveBar.projected_zscore || 0) > 2
                                ? 'text-red-400'
                                : Math.abs(currentLiveBar.projected_zscore || 0) > 1
                                  ? 'text-yellow-400'
                                  : 'text-green-400'
                            }`}>
                              {currentLiveBar.projected_zscore?.toFixed(2) || 'N/A'}
                            </td>

                            <td className="text-right p-3 font-bold text-blue-300">
                              {currentLiveBar.est_vol_at_close
                                ? `${(currentLiveBar.est_vol_at_close * 100).toFixed(0)}%`
                                : 'N/A'}
                            </td>

                            <td className="p-3">
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
                            <td className="p-3 text-sm">
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

                            <td className="p-3 font-mono">
                              {bar.band || bar.timeband}
                            </td>

                            <td className="text-right p-3 font-semibold">
                              {bar.volume?.toLocaleString()}
                            </td>

                            <td className="text-right p-3">
                              {bar.close?.toFixed(2)}
                            </td>

                            <td className={`text-right p-3 font-bold ${
                              ((bar.close - bar.open) / bar.open * 100) >= 0
                                ? 'text-green-400'
                                : 'text-red-400'
                            }`}>
                              {bar.open && bar.close
                                ? `${((bar.close - bar.open) / bar.open * 100).toFixed(2)}%`
                                : 'N/A'}
                            </td>

                            <td className="text-right p-3 text-gray-400 text-sm">
                              {bar.avg_20d?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </td>

                            <td className={`text-right p-3 font-bold ${
                              Math.abs(bar.zscore_20d || 0) > 2
                                ? 'text-red-400'
                                : Math.abs(bar.zscore_20d || 0) > 1
                                  ? 'text-yellow-400'
                                  : 'text-green-400'
                            }`}>
                              {bar.zscore_20d?.toFixed(2) || 'N/A'}
                            </td>

                            <td className="text-right p-3">
                              {(bar.ratio_to_avg_20d * 100)?.toFixed(0)}%
                            </td>

                            <td className="p-3">
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
      </div>
    </div>
  )
}
