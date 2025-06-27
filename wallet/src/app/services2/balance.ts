import { Injectable } from '@chroma/core';

const TAOSTATS_KEY =
  process.env.TAOSTATS_KEY || 'tao-713e72d2-6691-4519-99e1-c4a6c4735b21:705a3383';

@Injectable()
export class BalanceService {
  /**
   * Fetches the latest price of TAO from the TAOStats API.
   * @returns
   */
  async fetchPrice() {
    const endpoint = `https://api.taostats.io/api/price/latest/v1?asset=tao`;
    const res = await fetch(endpoint, {
      headers: { accept: 'application/json', authorization: TAOSTATS_KEY },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch price: ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    const { price } = json.data?.[0] ?? {};
    return {
      price,
      formatted: {
        price: (price / 1e9).toFixed(9),
      },
    };
  }

  /**
   * Fetches the balance for a given address.
   * @param address - The address to fetch the balance for.
   * @returns An object containing free and total balance, formatted as strings.
   */
  async fetch(address: string) {
    const endpoint = `https://api.taostats.io/api/account/latest/v1?address=${'5EUg6hRXFmNSVkCBBYQb2DqoeoPhQbfVnitUdGps2Uy2e12q' ?? address}&network=Finney&page=1&limit=50`;

    const [res, price] = await Promise.all([
      fetch(endpoint, {
        headers: { accept: 'application/json', authorization: TAOSTATS_KEY },
      }),
      this.fetchPrice(),
    ]);

    if (!res.ok) {
      throw new Error(`Failed to fetch balance: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    const { balance_free: free, balance_total: total } = json.data?.[0] ?? {};

    return {
      price,
      free,
      total,
      formatted: {
        free: (free / 1e9).toFixed(9),
        total: (total / 1e9).toFixed(9),
        transferable: (free / 1e9).toFixed(9),
      },
    };
  }

  /**
   * Fetches the transaction history for a given address.
   * @param address
   * @returns
   */
  async history(address: string) {
    const endpoint = `https://api.taostats.io/api/transfer/v1?address=${'5EUg6hRXFmNSVkCBBYQb2DqoeoPhQbfVnitUdGps2Uy2e12q' ?? address}&network=finney&page=1&limit=50`;
    const headers = {
      accept: 'application/json',
      authorization: TAOSTATS_KEY,
    };
    try {
      const res = await fetch(endpoint, { headers });

      if (!res.ok) {
        throw new Error(`Failed to fetch history: ${res.status} ${res.statusText}`);
      }

      const json = await res.json();

      return json.data.map(
        (item: {
          id: string;
          from: { hex: string };
          to: { hex: string };
          amount: string;
          timestamp: string;
          type: string;
        }) => ({
          id: item.id,
          from: item.from,
          to: item.to,
          amount: item.amount,
          timestamp: item.timestamp,
          type: item.type,
        }),
      );
    } catch (error) {
      console.error('Error fetching history:', error);
      throw error;
    }
  }
}
