import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { Providers } from './app/Providers';
import { applyTheme } from './stores/theme';
import { installGlobalErrorHandlers } from './app/global-errors';
import './styles/tailwind.css';
applyTheme();
installGlobalErrorHandlers();
createRoot(document.getElementById('root')!).render(
  <Providers>
    <App />
  </Providers>,
);
