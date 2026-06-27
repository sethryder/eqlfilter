import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// No StrictMode: the ported component attaches document listeners and does a
// one-time hash/draft restore in componentDidMount; double-invoke would just
// add noise. ponytail: add StrictMode if/when we want the dev double-render checks.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
