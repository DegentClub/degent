// Degent Marketplace — browser client.
//
// Security notes:
//  * Nothing from the server or the wallet is ever put through innerHTML. All
//    rendering goes through el()/text() which use createElement/textContent.
//  * The client never builds transactions. It asks the server for a PSBT,
//    lets UniSat sign it, and hands the signed PSBT back for verification and
//    broadcast.
//  * Ownership of a listing is proven per action with a BIP-322 message
//    signature over a server-issued challenge.

'use strict';

// ── State ──
const state = {
  connected: false,
  address: null,
  publicKey: null,
  balance: null,
  inscriptions: [],
  cursor: 0,
  pageSize: 20,
  total: 0,
  loading: false,
  activeTab: 'my-inscriptions',
  listingTarget: null,
  buyTarget: null,
  buyQuote: null,
  feeTier: 'normal',
  feePresets: null,
  collection: [],
  collectionMap: new Map(),
  config: { buysEnabled: false, network: 'mainnet', mempoolWeb: 'https://mempool.space', priceMinSats: 1000, priceMaxSats: 1e10, listingMaxDays: 30 },
};

const ORD_CONTENT_BASE = 'https://ordinals.com';
const SIGHASH_SINGLE_ANYONECANPAY = 0x83;

// ── DOM helpers (XSS-safe) ──
const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function show(node) { node.classList.remove('hidden'); }
function hide(node) { node.classList.add('hidden'); }

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  wallet: [['rect', { x: 2, y: 6, width: 20, height: 12, rx: 2 }], ['path', { d: 'M22 10h-4a2 2 0 000 4h4' }]],
  logout: [['path', { d: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4' }], ['polyline', { points: '16 17 21 12 16 7' }], ['line', { x1: 21, y1: 12, x2: 9, y2: 12 }]],
  plus: [['path', { d: 'M12 2v20M2 12h20' }]],
  check: [['path', { d: 'M20 6L9 17l-5-5' }]],
};
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'btn-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  for (const [tag, attrs] of ICONS[name]) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, String(v));
    svg.append(child);
  }
  return svg;
}
function setButton(btn, iconName, label) {
  clear(btn);
  btn.append(icon(iconName), el('span', {}, label));
}

// ── DOM refs ──
const hero = $('#hero');
const loadingSection = $('#loading-section');
const inscriptionsSection = $('#inscriptions-section');
const inscriptionsGrid = $('#inscriptions-grid');
const emptyState = $('#empty-state');
const connectBtn = $('#connect-btn');
const heroConnectBtn = $('#hero-connect-btn');
const refreshBtn = $('#refresh-btn');
const loadMoreBtn = $('#load-more-btn');
const loadMoreWrap = $('#load-more-wrap');
const noWalletModal = $('#no-wallet-modal');
const noWalletClose = $('#no-wallet-close');
const walletInfo = $('#wallet-info');
const balanceBadge = $('#balance-badge');
const addressBadge = $('#address-badge');
const detailModal = $('#detail-modal');
const detailClose = $('#detail-close');
const marketSection = $('#market-section');
const marketGrid = $('#market-grid');
const marketEmpty = $('#market-empty');
const marketTotalLabel = $('#market-total-label');
const marketCountBadge = $('#market-count-badge');
const listModal = $('#list-modal');
const listModalClose = $('#list-modal-close');
const listPriceInput = $('#list-price-input');
const listPriceHint = $('#list-price-hint');
const listConfirmBtn = $('#list-confirm-btn');
const tabNav = $('#tab-nav');
const listStatus = $('#list-status');
const buyModal = $('#buy-modal');
const buyModalClose = $('#buy-modal-close');
const buyConfirmBtn = $('#buy-confirm-btn');
const buyStatus = $('#buy-status');
const buysBanner = $('#buys-paused-banner');
const feeTierGroup = $('#fee-tier-group');

// ── API ──
async function api(path, body) {
  const init = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const resp = await fetch(path, init);
  let data = null;
  try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) {
    const err = new Error((data && data.error) || `Request failed (${resp.status})`);
    err.status = resp.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

async function loadConfig() {
  try {
    state.config = { ...state.config, ...(await api('/api/config')) };
  } catch (err) {
    console.error('Failed to load config:', err);
  }
  applyBuyPolicy();
}

function applyBuyPolicy() {
  if (state.config.buysEnabled) hide(buysBanner); else show(buysBanner);
}

async function loadCollection() {
  try {
    state.collection = await api('/api/collection');
    state.collectionMap = new Map(state.collection.map((item) => [item.inscription_id, item]));
  } catch (err) {
    console.error('Failed to load collection:', err);
    const sub = hero.querySelector('.hero-sub');
    if (sub) sub.textContent = 'Error: could not load collection data. Please refresh the page.';
  }
}

function getCollectionName(id) {
  const meta = state.collectionMap.get(id);
  return meta ? meta.name : null;
}
function isInCollection(id) { return state.collectionMap.has(id); }

async function getListings() {
  try {
    const listings = await api('/api/listings');
    return listings.filter((l) => isInCollection(l.inscriptionId));
  } catch { return []; }
}

async function getListing(id) {
  try { return await api(`/api/listings/${encodeURIComponent(id)}`); } catch { return null; }
}

async function getMyListedCount() {
  if (!state.address) return 0;
  const listings = await getListings();
  return listings.filter((l) => l.sellerAddress === state.address).length;
}

// ── Formatting ──
function truncateAddress(addr) {
  if (!addr) return '';
  return addr.slice(0, 8) + '...' + addr.slice(-6);
}
function formatNumber(n) { return n != null && !Number.isNaN(Number(n)) ? Number(n).toLocaleString() : '—'; }
function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}
function satsToBtc(sats) { return (Number(sats) / 1e8).toFixed(8) + ' BTC'; }
function isValidInscriptionId(id) { return /^[0-9a-f]{64}i\d{1,6}$/.test(String(id || '')); }

// ── Preview rendering ──
function buildPreview(insc) {
  const contentType = String(insc.contentType || '');
  const id = String(insc.inscriptionId || '');
  const isImage = contentType.startsWith('image/');
  const isHtml = contentType.startsWith('text/html');
  const isText = contentType.startsWith('text/') && !isHtml;
  const isSvg = contentType === 'image/svg+xml';
  const label = getCollectionName(id) || `Degent #${formatNumber(insc.inscriptionNumber)}`;

  if (!isValidInscriptionId(id)) return el('div', { class: 'preview-placeholder' }, 'Preview unavailable');
  if (isImage && !isSvg) {
    const img = el('img', { src: `${ORD_CONTENT_BASE}/content/${id}`, alt: label, loading: 'lazy' });
    img.addEventListener('error', () => {
      const ph = el('div', { class: 'preview-placeholder' }, 'Preview unavailable');
      if (img.parentElement) img.parentElement.replaceChild(ph, img);
    });
    return img;
  }
  if (isSvg || isHtml) {
    return el('iframe', { src: `${ORD_CONTENT_BASE}/preview/${id}`, sandbox: 'allow-scripts', loading: 'lazy', title: label });
  }
  if (isText) return el('div', { class: 'preview-placeholder preview-text' }, 'Text Inscription');
  return el('div', { class: 'preview-placeholder' }, contentType || 'Unknown type');
}

// ── Tabs / views ──
async function switchTab(tab) {
  state.activeTab = tab;
  tabNav.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  if (tab === 'my-inscriptions') {
    hide(marketSection);
    if (state.connected) { show(inscriptionsSection); hide(hero); } else { hide(inscriptionsSection); show(hero); }
  } else if (tab === 'market') {
    hide(inscriptionsSection); hide(hero); hide(loadingSection); show(marketSection);
    await renderMarket();
  }
}

function showView(view) {
  hide(hero); hide(loadingSection); hide(inscriptionsSection); hide(marketSection);
  if (view === 'hero') show(hero);
  else if (view === 'loading') show(loadingSection);
  else if (view === 'inscriptions') show(inscriptionsSection);
  else if (view === 'market') show(marketSection);
}

// ── Wallet ──
function hasUnisat() { return typeof window.unisat !== 'undefined'; }

async function connectWallet() {
  if (!hasUnisat()) { show(noWalletModal); return; }
  try {
    const accounts = await window.unisat.requestAccounts();
    if (!accounts || accounts.length === 0) return;
    state.address = accounts[0];
    state.publicKey = await window.unisat.getPublicKey();
    state.connected = true;
    updateWalletUI();
    await loadBalance();
    if (state.activeTab === 'my-inscriptions') await loadInscriptions(true);
  } catch (err) {
    console.error('Wallet connect error:', err);
    state.address = null;
    state.publicKey = null;
    if (err.code === 4001) return;
    alert('Failed to connect wallet: ' + (err.message || err));
  }
}

async function loadBalance() {
  try {
    state.balance = await window.unisat.getBalance();
    updateBalanceUI();
  } catch (err) { console.error('Balance error:', err); }
}

async function loadInscriptions(reset = false) {
  if (state.loading) return;
  state.loading = true;
  if (reset) {
    state.inscriptions = []; state.cursor = 0; state.total = 0;
    clear(inscriptionsGrid);
    showView('loading');
  }
  try {
    const result = await window.unisat.getInscriptions(state.cursor, state.pageSize);
    const totalFromWallet = result.total;
    state.cursor += result.list.length;
    const items = result.list.filter((i) => isInCollection(i.inscriptionId));
    state.inscriptions.push(...items);
    state.total = state.inscriptions.length;
    showView('inscriptions');
    await renderInscriptions(items, !reset);
    await updateStatsUI();
    await updateMarketBadge();
    const morePages = state.cursor < totalFromWallet;
    if (state.inscriptions.length === 0 && morePages) { state.loading = false; return loadInscriptions(false); }
    if (morePages && state.inscriptions.length > 0) show(loadMoreWrap); else hide(loadMoreWrap);
    if (state.inscriptions.length === 0) { show(emptyState); hide(inscriptionsGrid); } else { hide(emptyState); show(inscriptionsGrid); }
  } catch (err) {
    console.error('Load inscriptions error:', err);
    showView('inscriptions'); show(emptyState); hide(inscriptionsGrid);
  } finally { state.loading = false; }
}

/** All inscription outpoints the wallet knows about — never spent as payment. */
async function walletInscriptionOutpoints() {
  const out = [];
  try {
    let offset = 0;
    for (;;) {
      const r = await window.unisat.getInscriptions(offset, 100);
      if (!r || !r.list || r.list.length === 0) break;
      for (const i of r.list) {
        const parts = String(i.output || i.location || '').split(':');
        if (parts.length >= 2 && /^[0-9a-f]{64}$/.test(parts[0])) out.push(`${parts[0]}:${parts[1]}`);
      }
      offset += r.list.length;
      if (offset >= (r.total || 0)) break;
    }
  } catch (e) { console.warn('Could not enumerate wallet inscriptions:', e); }
  return [...new Set(out)];
}

// ── Rendering: My Degents ──
async function renderInscriptions(items, append = false) {
  if (!append) clear(inscriptionsGrid);
  const listingsMap = new Map((await getListings()).map((l) => [l.inscriptionId, l]));

  items.forEach((insc, idx) => {
    const listing = listingsMap.get(insc.inscriptionId);
    const shortType = String(insc.contentType || '').split('/').pop() || '?';
    const name = getCollectionName(insc.inscriptionId) || `#${formatNumber(insc.inscriptionNumber)}`;

    const preview = el('div', { class: 'card-preview' },
      buildPreview(insc),
      el('span', { class: 'card-content-type' }, shortType),
      listing && el('div', { class: 'card-listed-badge' }, el('span', {}, 'LISTED'), el('span', { class: 'listed-price' }, `${formatNumber(listing.priceSats)} sats`)),
    );
    const body = el('div', { class: 'card-body' },
      el('div', { class: 'card-number' }, name),
      el('div', { class: 'card-id' }, insc.inscriptionId),
      el('div', { class: 'card-value' }, `${formatNumber(insc.outputValue)} sats`),
    );
    const actions = el('div', { class: 'card-actions' });
    if (listing) {
      actions.append(
        el('button', { class: 'btn btn-danger btn-sm', onclick: (e) => { e.stopPropagation(); cancelListingFlow(insc.inscriptionId, () => refreshAll()); } }, 'Cancel Listing'),
      );
    } else {
      actions.append(el('button', { class: 'btn btn-accent btn-sm', onclick: (e) => { e.stopPropagation(); openListModal(insc); } }, 'List for Sale'));
    }
    preview.addEventListener('click', () => openDetail(insc, 'wallet'));
    body.addEventListener('click', () => openDetail(insc, 'wallet'));

    const card = el('div', { class: 'inscription-card', dataset: { inscriptionId: insc.inscriptionId } }, preview, body, actions);
    card.style.animationDelay = `${append ? 0 : idx * 0.03}s`;
    inscriptionsGrid.appendChild(card);
  });
}

async function refreshMyGrid() { await renderInscriptions(state.inscriptions, false); }
async function refreshAll() {
  if (state.connected) await refreshMyGrid();
  if (state.activeTab === 'market') await renderMarket();
  await updateMarketBadge();
  await updateStatsUI();
}

// ── Listing flow ──
function openListModal(insc) {
  state.listingTarget = insc;
  $('#list-modal-name').textContent = getCollectionName(insc.inscriptionId) || `Degent #${formatNumber(insc.inscriptionNumber)}`;
  $('#list-modal-id').textContent = insc.inscriptionId;
  const thumb = $('#list-modal-thumb');
  clear(thumb); thumb.append(buildPreview(insc));
  listPriceInput.value = '';
  listPriceInput.min = String(state.config.priceMinSats);
  listPriceInput.disabled = false;
  listPriceHint.textContent = '';
  listStatus.className = 'buy-status hidden';
  listStatus.textContent = '';
  listConfirmBtn.disabled = false;
  setButton(listConfirmBtn, 'plus', 'Sign & List');
  show(listModal);
  listPriceInput.focus();
}
function closeListModal() { hide(listModal); state.listingTarget = null; }
function setListStatus(type, message) {
  listStatus.className = `buy-status status-${type}`;
  listStatus.textContent = message;
}

async function confirmListing() {
  const insc = state.listingTarget;
  if (!insc || !state.connected) return;
  const price = parseInt(listPriceInput.value, 10);
  const { priceMinSats, priceMaxSats, listingMaxDays } = state.config;
  if (Number.isNaN(price) || price < priceMinSats || price > priceMaxSats) {
    listPriceHint.textContent = `Price must be between ${formatNumber(priceMinSats)} and ${formatNumber(priceMaxSats)} sats`;
    listPriceHint.classList.add('hint-danger');
    return;
  }
  listConfirmBtn.disabled = true;
  listPriceInput.disabled = true;
  try {
    setListStatus('pending', 'Checking inscription location with the indexer...');
    const prep = await api('/api/listings/prepare', {
      inscriptionId: insc.inscriptionId, sellerAddress: state.address, sellerPublicKey: state.publicKey, priceSats: price,
    });

    setListStatus('pending', 'Sign the listing in your wallet (input #2, SINGLE|ANYONECANPAY). The wallet will show the Degent being spent — that is the listing.');
    const signedPsbt = await window.unisat.signPsbt(prep.psbtHex, {
      autoFinalized: false,
      toSignInputs: [{ index: prep.signIndex, address: state.address, sighashTypes: [SIGHASH_SINGLE_ANYONECANPAY] }],
    });

    setListStatus('pending', 'Sign the ownership message...');
    const challenge = await api('/api/challenge', { action: 'list', address: state.address, inscriptionId: insc.inscriptionId, priceSats: price });
    const signature = await window.unisat.signMessage(challenge.message, 'bip322-simple');

    setListStatus('pending', 'Verifying and publishing...');
    await api('/api/listings', {
      inscriptionId: insc.inscriptionId, sellerAddress: state.address, sellerPublicKey: state.publicKey,
      priceSats: price, expiresInDays: listingMaxDays, signedPsbt, nonce: challenge.nonce, signature,
    });
    setListStatus('success', `Listed for ${formatNumber(price)} sats.`);
    setTimeout(async () => { closeListModal(); await refreshAll(); }, 800);
  } catch (err) {
    console.error('Listing error:', err);
    if (err.code === 4001) setListStatus('error', 'Signing rejected in wallet.');
    else setListStatus('error', err.message || 'Failed to create listing.');
    listConfirmBtn.disabled = false;
    listPriceInput.disabled = false;
  }
}

async function cancelListingFlow(inscriptionId, after) {
  if (!state.connected) return;
  try {
    const challenge = await api('/api/challenge', { action: 'cancel', address: state.address, inscriptionId });
    const signature = await window.unisat.signMessage(challenge.message, 'bip322-simple');
    await api(`/api/listings/${encodeURIComponent(inscriptionId)}/cancel`, { sellerAddress: state.address, nonce: challenge.nonce, signature });
    if (after) await after();
  } catch (err) {
    console.error('Cancel error:', err);
    if (err.code !== 4001) alert('Cancel failed: ' + (err.message || err));
  }
}

// ── Rendering: Market ──
async function renderMarket() {
  const listings = await getListings();
  clear(marketGrid);
  marketTotalLabel.textContent = `${listings.length} listing${listings.length !== 1 ? 's' : ''}`;
  if (listings.length === 0) { show(marketEmpty); hide(marketGrid); return; }
  hide(marketEmpty); show(marketGrid);

  listings.forEach((listing, idx) => {
    const shortType = String(listing.contentType || '').split('/').pop() || '?';
    const isOwn = !!state.address && listing.sellerAddress === state.address;
    const name = getCollectionName(listing.inscriptionId) || listing.name || `#${formatNumber(listing.inscriptionNumber)}`;

    const preview = el('div', { class: 'card-preview' }, buildPreview(listing), el('span', { class: 'card-content-type' }, shortType));
    const body = el('div', { class: 'card-body' },
      el('div', { class: 'card-number' }, name),
      el('div', { class: 'card-id' }, listing.inscriptionId),
      el('div', { class: 'market-seller' }, isOwn ? 'You' : truncateAddress(listing.sellerAddress)),
    );
    const action = isOwn
      ? el('button', { class: 'btn btn-danger btn-sm', onclick: (e) => { e.stopPropagation(); cancelListingFlow(listing.inscriptionId, () => refreshAll()); } }, 'Cancel')
      : buyButton(listing, 'btn btn-primary btn-sm', 'Buy Now');
    const priceRow = el('div', { class: 'market-card-price' },
      el('div', {}, el('div', { class: 'market-price-value' }, `${formatNumber(listing.priceSats)} sats`), el('div', { class: 'market-price-label' }, satsToBtc(listing.priceSats))),
      action,
    );
    preview.addEventListener('click', () => openDetail(listing, 'market'));
    body.addEventListener('click', () => openDetail(listing, 'market'));
    const card = el('div', { class: 'inscription-card' }, preview, body, priceRow);
    card.style.animationDelay = `${idx * 0.03}s`;
    marketGrid.appendChild(card);
  });
}

function buyButton(listing, cls, label) {
  const paused = !state.config.buysEnabled;
  return el('button', {
    class: cls,
    disabled: paused,
    title: paused ? 'Buying is paused while the settlement engine is rebuilt' : undefined,
    onclick: (e) => { e.stopPropagation(); if (!paused) openBuyModal(listing); },
  }, paused ? 'Buying paused' : label);
}

// ── Buy flow ──
async function openBuyModal(listing) {
  if (!state.config.buysEnabled) return;
  if (!state.connected) {
    if (!hasUnisat()) { show(noWalletModal); return; }
    await connectWallet();
    if (!state.connected) return;
  }
  if (state.address === listing.sellerAddress) { alert('You cannot buy your own listing.'); return; }

  state.buyTarget = listing;
  state.buyQuote = null;
  $('#buy-modal-name').textContent = getCollectionName(listing.inscriptionId) || listing.name || `Degent #${formatNumber(listing.inscriptionNumber)}`;
  $('#buy-modal-id').textContent = listing.inscriptionId;
  const thumb = $('#buy-modal-thumb');
  clear(thumb); thumb.append(buildPreview(listing));
  $('#buy-price-value').textContent = `${formatNumber(listing.priceSats)} sats`;
  $('#buy-royalty-value').textContent = '—';
  $('#buy-fee-value').textContent = '—';
  $('#buy-total-value').textContent = '—';
  $('#buy-seller-value').textContent = listing.sellerAddress;
  buyStatus.className = 'buy-status hidden';
  buyStatus.textContent = '';
  buyConfirmBtn.disabled = true;
  setButton(buyConfirmBtn, 'check', 'Confirm Purchase');
  buyConfirmBtn.onclick = executeBuy;
  show(buyModal);
  await refreshFeePresets();
  await requestQuote();
}

function closeBuyModal() { hide(buyModal); state.buyTarget = null; state.buyQuote = null; }
function setBuyStatus(type, message, link) {
  buyStatus.className = `buy-status status-${type}`;
  clear(buyStatus);
  buyStatus.append(message);
  if (link) buyStatus.append(' ', el('a', { href: link.href, target: '_blank', rel: 'noopener', class: 'status-link' }, link.label));
}

async function refreshFeePresets() {
  try {
    state.feePresets = await api('/api/fees');
    feeTierGroup.querySelectorAll('[data-tier]').forEach((btn) => {
      const rate = state.feePresets[btn.dataset.tier];
      btn.querySelector('.fee-rate').textContent = rate ? `${rate} sat/vB` : '—';
      btn.classList.toggle('active', btn.dataset.tier === state.feeTier);
    });
  } catch (err) { console.warn('Fee presets unavailable:', err); }
}

async function requestQuote() {
  const listing = state.buyTarget;
  if (!listing) return;
  buyConfirmBtn.disabled = true;
  try {
    setBuyStatus('pending', 'Selecting payment UTXOs and building the transaction...');
    const excludeOutpoints = await walletInscriptionOutpoints();
    const quote = await api('/api/buy/prepare', {
      inscriptionId: listing.inscriptionId, buyerAddress: state.address, buyerPublicKey: state.publicKey,
      feeTier: state.feeTier, excludeOutpoints,
    });
    state.buyQuote = quote;
    if (quote.needsDummies) {
      $('#buy-fee-value').textContent = `~${formatNumber(quote.summary.feeSats)} sats (setup)`;
      $('#buy-total-value').textContent = '—';
      setBuyStatus('pending', quote.note);
      setButton(buyConfirmBtn, 'check', 'Create padding UTXOs');
    } else {
      const s = quote.summary;
      $('#buy-royalty-value').textContent = `${formatNumber(s.royaltySats)} sats`;
      $('#buy-fee-value').textContent = `${formatNumber(s.feeSats)} sats (${s.feeRate} sat/vB, ~${s.estimatedVsize} vB)`;
      $('#buy-total-value').textContent = `${formatNumber(s.totalBuyerCost)} sats`;
      setBuyStatus('pending', quote.note);
      setButton(buyConfirmBtn, 'check', 'Confirm Purchase');
    }
    buyConfirmBtn.disabled = false;
  } catch (err) {
    console.error('Quote error:', err);
    setBuyStatus('error', err.message || 'Could not prepare purchase.');
  }
}

async function executeBuy() {
  const quote = state.buyQuote;
  if (!quote || !state.connected) return;
  buyConfirmBtn.disabled = true;
  try {
    setBuyStatus('pending', quote.needsDummies ? 'Sign the padding transaction in your wallet...' : 'Sign the purchase in your wallet. It spends your payment UTXOs and receives the Degent.');
    const signedPsbt = await window.unisat.signPsbt(quote.psbtHex, { autoFinalized: true, toSignInputs: quote.toSignInputs });
    setBuyStatus('pending', 'Verifying and broadcasting...');
    const result = await api('/api/buy/submit', { sessionId: quote.sessionId, signedPsbt });
    const link = { href: `${state.config.mempoolWeb}/tx/${result.txid}`, label: `${result.txid.slice(0, 12)}...${result.txid.slice(-8)}` };
    if (quote.needsDummies) {
      setBuyStatus('success', 'Padding UTXOs created. Wait for one confirmation, then open this listing again to buy.', link);
    } else {
      setBuyStatus('success', 'Purchase broadcast. The listing will show as sold once the network sees the transaction.', link);
    }
    setButton(buyConfirmBtn, 'check', 'Done');
    buyConfirmBtn.disabled = false;
    buyConfirmBtn.onclick = async () => { closeBuyModal(); await refreshAll(); buyConfirmBtn.onclick = executeBuy; };
    await loadBalance();
  } catch (err) {
    console.error('Buy error:', err);
    if (err.code === 4001) setBuyStatus('error', 'Transaction rejected in wallet.');
    else setBuyStatus('error', err.message || 'Transaction failed.');
    buyConfirmBtn.disabled = false;
  }
}

async function updateMarketBadge() {
  const listings = await getListings();
  if (listings.length > 0) { marketCountBadge.textContent = String(listings.length); show(marketCountBadge); } else hide(marketCountBadge);
}

// ── Detail modal ──
async function openDetail(insc, source) {
  const id = String(insc.inscriptionId);
  const contentType = String(insc.contentType || '');
  const preview = $('#detail-preview');
  clear(preview); preview.append(buildPreview(insc));

  $('#detail-title').textContent = getCollectionName(id) || `Degent #${formatNumber(insc.inscriptionNumber)}`;
  $('#detail-id').textContent = id;
  $('#detail-number').textContent = formatNumber(insc.inscriptionNumber);
  $('#detail-content-type').textContent = contentType || '—';
  $('#detail-content-length').textContent = formatBytes(insc.contentLength);
  $('#detail-genesis-tx').textContent = id.replace(/i\d+$/, '');
  $('#detail-location').textContent = insc.location || '—';
  $('#detail-output-value').textContent = insc.outputValue ? `${formatNumber(insc.outputValue)} sats` : '—';
  $('#detail-offset').textContent = insc.offset != null ? formatNumber(insc.offset) : (insc.satOffset != null ? formatNumber(insc.satOffset) : '—');

  const listing = await getListing(id);
  const active = listing && listing.status === 'active' ? listing : null;
  const badge = $('#detail-listing-badge');
  const actions = $('#detail-actions');
  const sellerField = $('#detail-seller-field');
  clear(actions);
  const explorerHref = isValidInscriptionId(id) ? `${ORD_CONTENT_BASE}/inscription/${id}` : '#';
  actions.append(el('a', { class: 'btn btn-ghost', href: explorerHref, target: '_blank', rel: 'noopener' }, 'View on Explorer'));

  if (active) {
    show(badge);
    $('#detail-listing-price').textContent = `${formatNumber(active.priceSats)} sats`;
    show(sellerField);
    $('#detail-seller').textContent = active.sellerAddress;
    const isOwn = !!state.address && active.sellerAddress === state.address;
    if (isOwn) {
      actions.append(el('button', { class: 'btn btn-danger detail-action', onclick: async () => { closeDetail(); await cancelListingFlow(id, () => refreshAll()); } }, 'Cancel Listing'));
    } else {
      const b = buyButton(active, 'btn btn-primary detail-action', `Buy for ${formatNumber(active.priceSats)} sats`);
      b.addEventListener('click', () => closeDetail());
      actions.append(b);
    }
  } else {
    hide(badge); hide(sellerField);
    if (source === 'wallet') {
      actions.append(el('button', { class: 'btn btn-primary detail-action', onclick: () => {
        closeDetail();
        const full = state.inscriptions.find((i) => i.inscriptionId === id);
        if (full) openListModal(full);
      } }, 'List for Sale'));
    }
  }
  show(detailModal);
}
function closeDetail() { hide(detailModal); clear($('#detail-preview')); }

// ── Wallet UI ──
function updateWalletUI() {
  if (!state.connected) return;
  setButton(connectBtn, 'logout', 'Logout');
  connectBtn.classList.remove('btn-primary');
  connectBtn.classList.add('btn-ghost');
  show(walletInfo);
  addressBadge.textContent = truncateAddress(state.address);
}
function updateBalanceUI() {
  if (state.balance) {
    const total = state.balance.total || 0;
    balanceBadge.textContent = formatNumber(total) + ' sats';
    $('#stat-balance').textContent = formatNumber(total);
  }
}
async function updateStatsUI() {
  $('#stat-total').textContent = formatNumber(state.total);
  $('#stat-listed').textContent = formatNumber(await getMyListedCount());
  $('#stat-address').textContent = truncateAddress(state.address);
  if (state.balance) $('#stat-balance').textContent = formatNumber(state.balance.total || 0);
}
function resetWalletState() {
  state.connected = false; state.address = null; state.publicKey = null; state.balance = null; state.inscriptions = [];
  hide(walletInfo);
  setButton(connectBtn, 'wallet', 'Connect Wallet');
  connectBtn.classList.add('btn-primary');
  connectBtn.classList.remove('btn-ghost');
  if (state.activeTab === 'my-inscriptions') showView('hero');
}
function disconnectWallet() { resetWalletState(); }

// ── Events ──
connectBtn.addEventListener('click', () => { if (state.connected) disconnectWallet(); else connectWallet(); });
heroConnectBtn.addEventListener('click', connectWallet);
noWalletClose.addEventListener('click', () => hide(noWalletModal));
tabNav.addEventListener('click', (e) => { const btn = e.target.closest('.tab-btn'); if (btn) switchTab(btn.dataset.tab); });
refreshBtn.addEventListener('click', () => { if (state.connected) { loadBalance(); loadInscriptions(true); } });
loadMoreBtn.addEventListener('click', () => { if (state.connected && !state.loading) loadInscriptions(false); });

listConfirmBtn.addEventListener('click', confirmListing);
listPriceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmListing(); });
listPriceInput.addEventListener('input', () => {
  const v = parseInt(listPriceInput.value, 10);
  const { priceMinSats, priceMaxSats } = state.config;
  if (listPriceInput.value && !Number.isNaN(v) && v >= priceMinSats && v <= priceMaxSats) {
    listPriceHint.textContent = satsToBtc(v); listPriceHint.classList.remove('hint-danger');
  } else if (listPriceInput.value) {
    listPriceHint.textContent = `Between ${formatNumber(priceMinSats)} and ${formatNumber(priceMaxSats)} sats`; listPriceHint.classList.add('hint-danger');
  } else listPriceHint.textContent = '';
});
listModalClose.addEventListener('click', closeListModal);
listModal.addEventListener('click', (e) => { if (e.target === listModal) closeListModal(); });

buyConfirmBtn.addEventListener('click', () => { /* handler assigned per modal open */ });
buyModalClose.addEventListener('click', closeBuyModal);
buyModal.addEventListener('click', (e) => { if (e.target === buyModal) closeBuyModal(); });
feeTierGroup.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-tier]');
  if (!btn || btn.dataset.tier === state.feeTier) return;
  state.feeTier = btn.dataset.tier;
  feeTierGroup.querySelectorAll('[data-tier]').forEach((b) => b.classList.toggle('active', b === btn));
  if (state.buyTarget) await requestQuote();
});

detailClose.addEventListener('click', closeDetail);
detailModal.addEventListener('click', (e) => { if (e.target === detailModal) closeDetail(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!buyModal.classList.contains('hidden')) closeBuyModal();
  else if (!listModal.classList.contains('hidden')) closeListModal();
  else if (!detailModal.classList.contains('hidden')) closeDetail();
  else if (!noWalletModal.classList.contains('hidden')) hide(noWalletModal);
});

if (hasUnisat()) {
  try {
    window.unisat.on('accountsChanged', async (accounts) => {
      if (!accounts || accounts.length === 0) { resetWalletState(); return; }
      state.address = accounts[0];
      try { state.publicKey = await window.unisat.getPublicKey(); } catch { state.publicKey = null; }
      state.connected = true;
      updateWalletUI();
      await loadBalance();
      if (state.activeTab === 'my-inscriptions') await loadInscriptions(true);
    });
  } catch { /* older wallet versions lack event support */ }
}

// ── Init ──
async function init() {
  await Promise.all([loadConfig(), loadCollection()]);
  await updateMarketBadge();
  if (!hasUnisat()) return;
  try {
    const accounts = await window.unisat.getAccounts();
    if (accounts && accounts.length > 0) {
      state.address = accounts[0];
      state.publicKey = await window.unisat.getPublicKey();
      state.connected = true;
      updateWalletUI();
      await loadBalance();
      await loadInscriptions(true);
    }
  } catch { /* not connected yet */ }
}
init();
