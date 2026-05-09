async function checkDex() {
  const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
  const data = await res.json();
  const solTokens = data.filter(t => t.chainId === 'solana');
  console.log('Latest Solana tokens:');
  console.log(solTokens.map(t => t.tokenAddress).slice(0, 5));
}
checkDex();
