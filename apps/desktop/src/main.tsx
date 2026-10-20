import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@xyflow/react/dist/style.css';
import './style.css';
createRoot(document.getElementById('root')!).render(<App />);
