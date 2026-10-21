import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { applyTheme, useThemeStore } from '@/stores/theme';
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 5000, refetchOnWindowFocus: false } },
      }),
  );
  useEffect(() => {
    applyTheme();
    const unsubscribe = useThemeStore.subscribe(applyTheme);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => useThemeStore.getState().setSystemDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => {
      unsubscribe();
      media.removeEventListener('change', update);
    };
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <TooltipProvider delayDuration={250}>
          {children}
          <Toaster position="bottom-right" closeButton />
        </TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
