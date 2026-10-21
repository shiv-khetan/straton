import { Component } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  render() {
    if (this.state.error !== null)
      return (
        <section
          className="m-6 max-w-prose space-y-4 rounded-card border border-danger p-6"
          role="alert"
        >
          <h2>Unable to display this screen</h2>
          <p>{this.state.error}</p>
          <Button onClick={() => this.setState({ error: null })}>Reload screen</Button>
        </section>
      );
    return this.props.children;
  }
}
