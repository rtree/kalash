import type { Address, Hex } from 'viem';

export function ExplorerLink({ value, kind, className }: {
  value: Address | Hex; kind: 'address' | 'tx'; className?: string;
}) {
  return <a className={className} href={`https://sepolia.basescan.org/${kind}/${value}`}
    target="_blank" rel="noopener noreferrer">{value.slice(0, 6)}...</a>;
}
