async function checkJup() {
  const res = await fetch('https://api.jup.ag/tokens/v1/new');
  const data = await res.json();
  console.log(data.slice(0, 5));
}
checkJup();
