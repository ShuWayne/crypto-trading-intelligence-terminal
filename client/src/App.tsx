import { BrowserRouter, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Overview from './pages/Overview'
import Markets from './pages/Markets'
import Signals from './pages/Signals'
import Indicator from './pages/Indicator'
import Gold from './pages/Gold'
import Scanner from './pages/Scanner'
import News from './pages/News'
import Charts from './pages/Charts'
import Risk from './pages/Risk'
import Backtest from './pages/Backtest'
import History from './pages/History'
import Settings from './pages/Settings'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Overview />} />
          <Route path="/markets" element={<Markets />} />
          <Route path="/signals" element={<Signals />} />
          <Route path="/indicator" element={<Indicator />} />
          <Route path="/gold" element={<Gold />} />
          <Route path="/scanner" element={<Scanner />} />
          <Route path="/news" element={<News />} />
          <Route path="/charts" element={<Charts />} />
          <Route path="/risk" element={<Risk />} />
          <Route path="/backtest" element={<Backtest />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Overview />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
