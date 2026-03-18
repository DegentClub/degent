#!/usr/bin/env node
// buy.js - Complete and broadcast an inscription listing
// Usage: node buy.js <listingFile> <buyerWallet>
// Example: node buy.js listing-60cee9d4-50000sats.json myWallet

const { execSync } = require('child_process');
const fs = require('fs');

function cli(cmd) {
  return JSON.parse(execSync(cmd, { encoding: 'utf8' }));
}

function cliRaw(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

const [,, listingFile, buyerWallet] = process.argv;

if (!listingFile || !buyerWallet) {
  console.error('Usage: node buy.js <listingFile> <buyerWallet>');
  console.error('Example: node buy.js listing-60cee9d4-50000sats.json myWallet');
  process.exit(1);
}

// Load listing
if (!fs.existsSync(listingFile)) {
  console.error(`Listing file not found: ${listingFile}`);
  process.exit(1);
}
const listing = JSON.parse(fs.readFileSync(listingFile, 'utf8'));
const { inscriptionId, location, postage, priceSats, sellerAddress, sellerSigHex } = listing;
const [inscTxid, inscVoutStr] = location.split(':');
const inscVout = parseInt(inscVoutStr);

console.log(`\nBuying inscription`);
console.log(`  Listing:     ${listingFile}`);
console.log(`  Inscription: ${inscriptionId}`);
console.log(`  Price:       ${priceSats} sats`);
console.log(`  Buyer wallet: ${buyerWallet}\n`);

// Estimate fee: ~255 vbytes for 2-input 3-output taproot tx at 6 sat/vbyte
const FEE_RATE = 6;
const EST_VBYTES = 255;
const estimatedFee = FEE_RATE * EST_VBYTES;
const totalNeeded = priceSats + postage + estimatedFee;
console.log(`Step 1: Finding buyer UTXO (need >= ${totalNeeded} sats)...`);

const utxos = cli(`bitcoin-cli -rpcwallet=${buyerWallet} listunspent`);
const spendable = utxos
  .filter(u => u.spendable && Math.round(u.amount * 1e8) >= totalNeeded)
  .sort((a, b) => a.amount - b.amount); // smallest sufficient first

if (spendable.length === 0) {
  console.error(`No spendable UTXO >= ${totalNeeded} sats found in wallet ${buyerWallet}`);
  console.error('Available UTXOs:');
  utxos.forEach(u => console.error(`  ${u.txid}:${u.vout} = ${Math.round(u.amount * 1e8)} sats`));
  process.exit(1);
}

const buyerUtxo = spendable[0];
const buyerUtxoSats = Math.round(buyerUtxo.amount * 1e8);
console.log(`  Selected: ${buyerUtxo.txid}:${buyerUtxo.vout} (${buyerUtxoSats} sats)`);

// Step 2 - Get buyer addresses
console.log('Step 2: Getting buyer addresses...');
const deliveryAddress = cliRaw(`bitcoin-cli -rpcwallet=${buyerWallet} getnewaddress "" bech32m`);
const changeAddress = cliRaw(`bitcoin-cli -rpcwallet=${buyerWallet} getrawchangeaddress bech32m`);
console.log(`  Delivery: ${deliveryAddress}`);
console.log(`  Change:   ${changeAddress}`);

// Step 3 - Calculate change
const changeSats = buyerUtxoSats - priceSats - postage - estimatedFee;
if (changeSats < 546) {
  console.error(`Change output too small (${changeSats} sats). Increase UTXO or lower fee estimate.`);
  process.exit(1);
}
console.log(`  Change:   ${changeSats} sats`);
console.log(`  Fee:      ~${estimatedFee} sats`);

// Step 4 - Create full PSBT (seller input first, then buyer input)
console.log('\nStep 3: Creating combined PSBT...');
const priceBtc = (priceSats / 1e8).toFixed(8);
const postageBtc = (postage / 1e8).toFixed(8);
const changeBtc = (changeSats / 1e8).toFixed(8);

const inputs = JSON.stringify([
  { txid: inscTxid, vout: inscVout },
  { txid: buyerUtxo.txid, vout: buyerUtxo.vout }
]);
const outputs = JSON.stringify([
  { [sellerAddress]: parseFloat(priceBtc) },
  { [deliveryAddress]: parseFloat(postageBtc) },
  { [changeAddress]: parseFloat(changeBtc) }
]);

const rawPsbt = cliRaw(`bitcoin-cli createpsbt '${inputs}' '${outputs}'`);

// Step 5 - Populate UTXO data
console.log('Step 4: Populating UTXO data...');
const updatedPsbt = cliRaw(`bitcoin-cli utxoupdatepsbt "${rawPsbt}"`);

// Step 6 - Buyer signs input 1
console.log('Step 5: Buyer signing input 1...');
const buyerSigned = cli(
  `bitcoin-cli -rpcwallet=${buyerWallet} walletprocesspsbt "${updatedPsbt}"`
);
console.log(`  Buyer signed, complete: ${buyerSigned.complete}`);

// Verify buyer sig was added
const decodedBuyer = cli(`bitcoin-cli decodepsbt "${buyerSigned.psbt}"`);
const buyerInput = decodedBuyer.inputs[1];
const hasBuyerSig = buyerInput.final_scriptwitness || buyerInput.tap_key_sig;
if (!hasBuyerSig) {
  console.error('  ERROR: Buyer signature not added. Does wallet own the selected UTXO?');
  process.exit(1);
}
console.log('  Buyer sig confirmed ✓');

// Step 7 - Inject seller final_scriptwitness into input 0
console.log('Step 6: Injecting seller signature into input 0...');

function injectSellerSig(psbtB64, sigHex) {
  const sigBytes = Buffer.from(sigHex, 'hex');
  let psbt = Buffer.from(psbtB64, 'base64');

  // Find end of global map
  let i = 5;
  while (psbt[i] !== 0x00) {
    const keyLen = psbt[i]; i++;
    i += keyLen;
    const valLen = psbt[i]; i++;
    i += valLen;
  }
  i++; // start of input 0 map

  // Remove any existing final_scriptwitness (key 0x08) in input 0
  let j = i;
  let removeStart = -1, removeEnd = -1;
  while (psbt[j] !== 0x00) {
    const entryStart = j;
    const keyLen = psbt[j]; j++;
    const keyType = psbt[j]; j += keyLen;
    const valLen = psbt[j]; j++;
    j += valLen;
    if (keyLen === 1 && keyType === 0x08) {
      removeStart = entryStart;
      removeEnd = j;
    }
  }
  if (removeStart !== -1) {
    psbt = Buffer.concat([psbt.slice(0, removeStart), psbt.slice(removeEnd)]);
  }

  // Re-find input 0 start
  i = 5;
  while (psbt[i] !== 0x00) {
    const keyLen = psbt[i]; i++;
    i += keyLen;
    const valLen = psbt[i]; i++;
    i += valLen;
  }
  i++;

  // Inject final_scriptwitness (key 0x08)
  const witnessStack = Buffer.concat([
    Buffer.from([0x01]),         // 1 stack item
    Buffer.from([sigBytes.length]), // item length
    sigBytes
  ]);
  const entry = Buffer.concat([
    Buffer.from([0x01, 0x08]),
    Buffer.from([witnessStack.length]),
    witnessStack
  ]);
  return Buffer.concat([psbt.slice(0, i), entry, psbt.slice(i)]).toString('base64');
}

const patchedPsbt = injectSellerSig(buyerSigned.psbt, sellerSigHex);
console.log('  Seller sig injected ✓');

// Step 8 - Finalize
console.log('Step 7: Finalizing...');
const finalized = cli(`bitcoin-cli finalizepsbt "${patchedPsbt}"`);
console.log(`  Complete: ${finalized.complete}`);

if (!finalized.complete) {
  console.error('  ERROR: Finalization failed. Input keys:');
  const dec = cli(`bitcoin-cli decodepsbt "${patchedPsbt}"`);
  dec.inputs.forEach((inp, idx) => {
    console.error(`  Input ${idx}: ${Object.keys(inp).join(', ')}`);
  });
  process.exit(1);
}

// Step 9 - Decode and confirm before broadcast
console.log('\nStep 8: Verifying transaction...');
const decoded = cli(`bitcoin-cli decoderawtransaction "${finalized.hex}"`);
console.log('  Inputs:');
decoded.vin.forEach((v, i) => console.log(`    [${i}] ${v.txid}:${v.vout}`));
console.log('  Outputs:');
decoded.vout.forEach((v, i) => {
  const sats = Math.round(v.value * 1e8);
  console.log(`    [${v.n}] ${sats} sats → ${v.scriptPubKey.address}`);
});
const totalOut = decoded.vout.reduce((s, v) => s + Math.round(v.value * 1e8), 0);
const actualFee = buyerUtxoSats + postage - totalOut;
console.log(`  Actual fee: ${actualFee} sats`);

// Step 10 - Broadcast
console.log('\nStep 9: Broadcasting...');
const txid = cliRaw(`bitcoin-cli sendrawtransaction "${finalized.hex}"`);
console.log(`\n✓ SUCCESS!`);
console.log(`  txid: ${txid}`);
console.log(`  https://mempool.space/tx/${txid}`);
console.log(`\n  Inscription ${inscriptionId}`);
console.log(`  delivered to ${deliveryAddress}`);