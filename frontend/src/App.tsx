import { useEffect, useState } from 'react';
import type { Item, CreateItemRequest, ListItemsResponse } from './api-types';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [name, setName] = useState('');
  const [status, setStatus] = useState<string>('');

  async function loadItems() {
    if (!API_URL) {
      setStatus('Set VITE_API_URL to your deployed API URL to connect.');
      return;
    }
    try {
      const res = await fetch(`${API_URL}items`);
      const data: ListItemsResponse = await res.json();
      setItems(data.items);
      setStatus('Connected to API');
    } catch {
      setStatus('Could not reach the API. Check VITE_API_URL and CORS.');
    }
  }

  async function addItem() {
    if (!name.trim()) return;
    const body: CreateItemRequest = { name: name.trim() };
    await fetch(`${API_URL}items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setName('');
    await loadItems();
  }

  useEffect(() => {
    void loadItems();
  }, []);

  return (
    <main style={{ maxWidth: 560, margin: '4rem auto', fontFamily: 'system-ui, sans-serif', padding: '0 1rem' }}>
      <h1>My app</h1>
      <p style={{ color: '#666' }}>{status}</p>
      <div style={{ display: 'flex', gap: 8, margin: '1rem 0' }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addItem()}
          placeholder="New item name"
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={() => void addItem()} style={{ padding: '8px 16px' }}>
          Add item
        </button>
      </div>
      <ul>
        {items.map((it) => (
          <li key={it.id}>
            {it.name} <small style={{ color: '#999' }}>{new Date(it.createdAt).toLocaleString()}</small>
          </li>
        ))}
      </ul>
    </main>
  );
}
