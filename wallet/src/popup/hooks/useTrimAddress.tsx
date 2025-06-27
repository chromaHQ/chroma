export function useTrimAddress() {
  const trimAddress = (address: string): string => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  return trimAddress;
}
