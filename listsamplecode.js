#!/usr/bin/env node
// list.js - Create an inscription listing PSBT
// Usage: node list.js <wallet> <inscriptionId> <priceSats>
// Example: node list.js psbtTester 60cee9d4...i0 50000

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function cli(cmd) {
  return JSON.parse(execSync(cmd, { encoding: 'utf8' }));
}

function cliRaw(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

const [,, wallet, inscriptionId, priceSatsArg] = process.argv;

if (!wallet || !inscriptionId || !priceSatsArg) {
  console.error('Usage: node list.js <wallet> <inscriptionId> <priceSats>');
  console.error('Example: node list.js psbtTester 60cee9d4...i0 50000');
  process.exit(1);
}

const priceSats = parseInt(priceSatsArg);
if (isNaN(priceSats) || priceSats < 546) {
  console.error('Price must be a number >= 546 sats');
  process.exit(1);
}

console.log(`\nListing inscription for sale`);
console.log(`  Wallet:      ${wallet}`);
console.log(`  Inscription: ${inscriptionId}`);
console.log(`  Price:       ${priceSats} sats\n`);

// Step 1 - Find inscription location
console.log('Step 1: Looking up inscription location...');
const inscriptions = cli(`ord wallet --name ${wallet} inscriptions`);
const inscription = inscriptions.find(i => i.inscription === inscriptionId);
if (!inscription) {
  console.error(`Inscription ${inscriptionId} not found in wallet ${wallet}`);
  console.error('Available inscriptions:');
  inscriptions.forEach(i => console.error(`  ${i.inscription} @ ${i.location}`));
  process.exit(1);
}

const [txid, voutStr] = inscription.location.split(':');
const vout = parseInt(voutStr);
const postage = inscription.postage;
console.log(`  Location: ${txid}:${vout} (${postage} sats postage)`);

// Step 2 - Get seller address
console.log('Step 2: Getting seller address...');
const utxoInfo = cli(`bitcoin-cli -rpcwallet=${wallet} gettxout ${txid} ${vout}`);
const sellerAddress = utxoInfo.scriptPubKey.address;
console.log(`  Seller address: ${sellerAddress}`);

// Step 3 - Create seller-only PSBT
console.log('Step 3: Creating seller PSBT...');
const priceBtc = (priceSats / 1e8).toFixed(8);
const unsignedPsbt = cliRaw(
  `bitcoin-cli createpsbt '[{"txid":"${txid}","vout":${vout}}]' '[{"${sellerAddress}":${priceBtc}}]'`
);

// Step 4 - Update PSBT with UTXO data
console.log('Step 4: Populating UTXO data...');
const updatedPsbt = cliRaw(`bitcoin-cli utxoupdatepsbt "${unsignedPsbt}"`);

// Step 5 - Sign with SINGLE|ANYONECANPAY
console.log('Step 5: Signing with SINGLE|ANYONECANPAY...');
const signResult = cli(
  `bitcoin-cli -rpcwallet=${wallet} walletprocesspsbt "${updatedPsbt}" true "SINGLE|ANYONECANPAY"`
);

// Extract the final_scriptwitness from the signed PSBT
const decoded = cli(`bitcoin-cli decodepsbt "${signResult.psbt}"`);
const input0 = decoded.inputs[0];
let sellerSigHex = null;

if (input0.final_scriptwitness && input0.final_scriptwitness.length > 0) {
  sellerSigHex = input0.final_scriptwitness[0];
  console.log(`  Signature: ${sellerSigHex.slice(0, 16)}... (${sellerSigHex.length / 2} bytes)`);
  const sighashByte = sellerSigHex.slice(-2);
  if (sighashByte !== '83') {
    console.warn(`  WARNING: Expected sighash byte 0x83 (SINGLE|ANYONECANPAY), got 0x${sighashByte}`);
  } else {
    console.log(`  Sighash: 0x83 (SINGLE|ANYONECANPAY) ✓`);
  }
} else {
  console.error('  ERROR: No signature found in PSBT. Wallet may not own this inscription.');
  process.exit(1);
}

// Step 6 - Save listing
const listing = {
  version: 1,
  inscriptionId,
  location: `${txid}:${vout}`,
  postage,
  priceSats,
  sellerAddress,
  sellerSigHex,
  psbt: signResult.psbt,
  createdAt: new Date().toISOString(),
};

const filename = `listing-${inscriptionId.slice(0, 16)}-${priceSats}sats.json`;
fs.writeFileSync(filename, JSON.stringify(listing, null, 2));

console.log(`\n✓ Listing created: ${filename}`);
console.log(`  Inscription: ${inscriptionId}`);
console.log(`  Price:       ${priceSats} sats`);
console.log(`  Seller gets: ${sellerAddress}`);