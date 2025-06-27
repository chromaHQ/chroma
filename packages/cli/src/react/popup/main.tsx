import React from 'react';
import { createRoot } from 'react-dom/client';
import { BridgeProvider, useConnectionStatus } from '@chroma/react';

const App = () => {
  const status = useConnectionStatus();
  return (
    <BridgeProvider>
      <div style={{ padding: 16 }}>
        <h1><%= name %></h1>
        <p>Status: {status}</p>
        <p>Edit <code>popup/main.tsx</code> and save to reload.</p>
      </div>
    </BridgeProvider>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
