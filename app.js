// ── State ──
const state = {
  connected: false,
  address: null,
  balance: null,
  inscriptions: [],
  cursor: 0,
  pageSize: 20,
  total: 0,
  loading: false,
  activeTab: 'my-inscriptions',
  listingTarget: null,
  buyTarget: null,
};

const FEE_RATE = 1;
const EST_VBYTES = 255;
const EST_FEE = FEE_RATE * EST_VBYTES;

// ── DOM refs ──
const $ = (sel) => document.querySelector(sel);
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

// ── Ordinals content preview base URL ──
const ORD_CONTENT_BASE = 'https://ordinals.com';

// ── Listings Store (IndexedDB + Server Sync) ──
const DB_NAME = 'degent_marketplace';
const DB_VERSION = 1;
const STORE_NAME = 'listings';

let _db = null;
let _serverOk = null; // null = untested, true/false = result

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'inscriptionId' });
        store.createIndex('sellerAddress', 'sellerAddress', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

// ── Server sync helpers ──
async function checkServer() {
  if (_serverOk !== null) return _serverOk;
  try {
    const resp = await fetch('/api/health');
    const data = await resp.json();
    _serverOk = data.ok === true;
  } catch { _serverOk = false; }
  console.log('Server sync:', _serverOk ? 'available' : 'unavailable (local-only mode)');
  return _serverOk;
}

async function syncUpload(listing) {
  try {
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(listing))));
    const resp = await fetch(`/api/listings/create?data=${encoded}`);
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `${resp.status}`);
    }
    console.log('Synced listing to server:', listing.inscriptionId);
  } catch (err) {
    console.warn('Server sync failed (local still saved):', err.message);
  }
}

async function serverGetListings() {
  try {
    const resp = await fetch('/api/listings');
    if (!resp.ok) return [];
    return await resp.json();
  } catch { return []; }
}

async function serverRemove(inscriptionId, sellerAddress) {
  try {
    await fetch(`/api/listings/${encodeURIComponent(inscriptionId)}/cancel?seller=${encodeURIComponent(sellerAddress)}`);
  } catch {}
}

async function serverMarkSold(inscriptionId) {
  try {
    await fetch(`/api/listings/${encodeURIComponent(inscriptionId)}/sold`);
  } catch {}
}

// ── IndexedDB helpers ──
async function idbGetAll() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const idx = tx.objectStore(STORE_NAME).index('status');
    const req = idx.getAll('active');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve([]);
  });
}

async function idbPut(listing) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(listing);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(inscriptionId) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(inscriptionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function idbGet(inscriptionId) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(inscriptionId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

// ── Public listing functions (IndexedDB + server sync) ──
async function getListings() {
  const local = await idbGetAll();
  if (!await checkServer()) return local;

  // Merge: server listings + local-only listings
  const remote = await serverGetListings();
  const merged = new Map();
  remote.forEach(l => merged.set(l.inscriptionId, l));
  local.forEach(l => merged.set(l.inscriptionId, l)); // local wins on conflict
  return [...merged.values()];
}

async function addListing(listing) {
  listing.status = 'active';
  await idbPut(listing);
  if (await checkServer()) {
    await syncUpload(listing);
  }
}

async function removeListing(inscriptionId) {
  await idbDelete(inscriptionId);
  if (await checkServer()) {
    await serverRemove(inscriptionId, state.address);
  }
}

async function markListingSold(inscriptionId) {
  const listing = await idbGet(inscriptionId);
  if (listing) {
    listing.status = 'sold';
    await idbPut(listing);
  }
  if (await checkServer()) {
    await serverMarkSold(inscriptionId);
  }
}

async function getListing(inscriptionId) {
  const local = await idbGet(inscriptionId);
  if (local && local.status === 'active') return local;
  if (!await checkServer()) return null;
  try {
    const resp = await fetch(`/api/listings/${encodeURIComponent(inscriptionId)}`);
    if (resp.status === 404) return null;
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

async function getMyListedCount() {
  if (!state.address) return 0;
  const listings = await getListings();
  return listings.filter(l => l.sellerAddress === state.address).length;
}

// ── Helpers ──
function truncateAddress(addr) {
  if (!addr) return '';
  return addr.slice(0, 8) + '...' + addr.slice(-6);
}

function formatNumber(n) {
  return n != null ? n.toLocaleString() : '—';
}

function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

function satsToBtc(sats) {
  return (sats / 1e8).toFixed(8) + ' BTC';
}

function buildPreviewHtml(insc, size) {
  const contentType = insc.contentType || '';
  const isImage = contentType.startsWith('image/');
  const isHtml = contentType.startsWith('text/html');
  const isText = contentType.startsWith('text/') && !isHtml;
  const isSvg = contentType === 'image/svg+xml';
  const inscriptionId = insc.inscriptionId;
  const contentUrl = `${ORD_CONTENT_BASE}/content/${inscriptionId}`;
  const previewUrl = `${ORD_CONTENT_BASE}/preview/${inscriptionId}`;

  if (isImage && !isSvg) {
    return `<img src="${contentUrl}" alt="Inscription #${insc.inscriptionNumber}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'preview-placeholder\\'>Preview unavailable</div>'">`;
  } else if (isSvg || isHtml) {
    return `<iframe src="${previewUrl}" sandbox="allow-scripts" loading="lazy" title="Inscription #${insc.inscriptionNumber}"></iframe>`;
  } else if (isText) {
    return `<div class="preview-placeholder" style="font-family:var(--mono);font-size:0.7rem;">Text Inscription</div>`;
  }
  return `<div class="preview-placeholder">${contentType || 'Unknown type'}</div>`;
}

// ── Tab Navigation ──
async function switchTab(tab) {
  state.activeTab = tab;

  tabNav.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  if (tab === 'my-inscriptions') {
    marketSection.classList.add('hidden');
    if (state.connected) {
      inscriptionsSection.classList.remove('hidden');
      hero.classList.add('hidden');
    } else {
      inscriptionsSection.classList.add('hidden');
      hero.classList.remove('hidden');
    }
  } else if (tab === 'market') {
    inscriptionsSection.classList.add('hidden');
    hero.classList.add('hidden');
    loadingSection.classList.add('hidden');
    marketSection.classList.remove('hidden');
    await renderMarket();
  }
}

// ── View management ──
function showView(view) {
  hero.classList.add('hidden');
  loadingSection.classList.add('hidden');
  inscriptionsSection.classList.add('hidden');
  marketSection.classList.add('hidden');

  if (view === 'hero') hero.classList.remove('hidden');
  else if (view === 'loading') loadingSection.classList.remove('hidden');
  else if (view === 'inscriptions') inscriptionsSection.classList.remove('hidden');
  else if (view === 'market') marketSection.classList.remove('hidden');
}

// ── UniSat Wallet Integration ──
function hasUnisat() {
  return typeof window.unisat !== 'undefined';
}

async function connectWallet() {
  if (!hasUnisat()) {
    noWalletModal.classList.remove('hidden');
    return;
  }

  try {
    const accounts = await window.unisat.requestAccounts();
    if (!accounts || accounts.length === 0) return;

    state.address = accounts[0];

    // Authenticate: sign a message to prove address ownership
    const timestamp = Date.now();
    const authMessage = `Sign in to Degent Marketplace\nAddress: ${state.address}\nTimestamp: ${timestamp}`;
    const signature = await window.unisat.signMessage(authMessage);

    if (!signature) {
      state.address = null;
      return;
    }

    console.log(`Auth signature: ${signature.slice(0, 20)}... for ${state.address}`);
    state.connected = true;

    updateWalletUI();
    await loadBalance();
    if (state.activeTab === 'my-inscriptions') {
      await loadInscriptions(true);
    }
  } catch (err) {
    console.error('Wallet connect error:', err);
    state.address = null;
    if (err.code === 4001) return;
    alert('Failed to connect wallet: ' + (err.message || err));
  }
}

async function loadBalance() {
  try {
    const balance = await window.unisat.getBalance();
    state.balance = balance;
    updateBalanceUI();
  } catch (err) {
    console.error('Balance error:', err);
  }
}

async function loadInscriptions(reset = false) {
  if (state.loading) return;
  state.loading = true;

  if (reset) {
    state.inscriptions = [];
    state.cursor = 0;
    state.total = 0;
    inscriptionsGrid.innerHTML = '';
    showView('loading');
  }

  try {
    const result = await window.unisat.getInscriptions(state.cursor, state.pageSize);

    state.total = result.total;
    state.inscriptions.push(...result.list);
    state.cursor += result.list.length;

    showView('inscriptions');
    renderInscriptions(result.list, !reset);
    updateStatsUI();
    updateMarketBadge();

    if (state.cursor < state.total) {
      loadMoreWrap.classList.remove('hidden');
    } else {
      loadMoreWrap.classList.add('hidden');
    }

    if (state.inscriptions.length === 0) {
      emptyState.classList.remove('hidden');
      inscriptionsGrid.classList.add('hidden');
    } else {
      emptyState.classList.add('hidden');
      inscriptionsGrid.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Load inscriptions error:', err);
    showView('inscriptions');
    emptyState.classList.remove('hidden');
    inscriptionsGrid.classList.add('hidden');
  } finally {
    state.loading = false;
  }
}

// ── Rendering: My Inscriptions ──
async function renderInscriptions(items, append = false) {
  if (!append) inscriptionsGrid.innerHTML = '';

  // Pre-fetch all listings to avoid N+1 API calls
  const allListings = await getListings();
  const listingsMap = new Map(allListings.map(l => [l.inscriptionId, l]));

  items.forEach((insc, idx) => {
    const card = document.createElement('div');
    card.className = 'inscription-card';
    card.dataset.inscriptionId = insc.inscriptionId;
    card.style.animationDelay = `${(append ? 0 : idx * 0.03)}s`;

    const contentType = insc.contentType || '';
    const shortType = contentType.split('/').pop() || '?';
    const listing = listingsMap.get(insc.inscriptionId);

    let listedBadge = '';
    if (listing) {
      listedBadge = `<div class="card-listed-badge"><span>LISTED</span><span class="listed-price">${formatNumber(listing.priceSats)} sats</span></div>`;
    }

    card.innerHTML = `
      <div class="card-preview">
        ${buildPreviewHtml(insc)}
        <span class="card-content-type">${shortType}</span>
        ${listedBadge}
      </div>
      <div class="card-body">
        <div class="card-number">#${formatNumber(insc.inscriptionNumber)}</div>
        <div class="card-id">${insc.inscriptionId}</div>
        <div class="card-value">${formatNumber(insc.outputValue)} sats</div>
      </div>
      <div class="card-actions">
        ${listing
          ? `<button class="btn btn-danger btn-sm cancel-listing-btn" data-id="${insc.inscriptionId}">Cancel Listing</button>
             <button class="btn btn-accent btn-sm edit-listing-btn" data-id="${insc.inscriptionId}">Edit Price</button>`
          : `<button class="btn btn-accent btn-sm list-btn" data-id="${insc.inscriptionId}">List for Sale</button>`
        }
      </div>
    `;

    card.querySelector('.card-preview').addEventListener('click', () => openDetail(insc, 'wallet'));
    card.querySelector('.card-body').addEventListener('click', () => openDetail(insc, 'wallet'));

    inscriptionsGrid.appendChild(card);
  });

  bindCardActions(listingsMap);
}

function bindCardActions(listingsMap) {
  document.querySelectorAll('.list-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const insc = state.inscriptions.find(i => i.inscriptionId === id);
      if (insc) openListModal(insc);
    };
  });

  document.querySelectorAll('.cancel-listing-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      await removeListing(btn.dataset.id);
      await refreshMyGrid();
      await updateMarketBadge();
      await updateStatsUI();
    };
  });

  document.querySelectorAll('.edit-listing-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const insc = state.inscriptions.find(i => i.inscriptionId === id);
      if (insc) {
        const listing = listingsMap ? listingsMap.get(id) : await getListing(id);
        openListModal(insc, listing ? listing.priceSats : null);
      }
    };
  });
}

async function refreshMyGrid() {
  await renderInscriptions(state.inscriptions, false);
}

// ── List for Sale Modal ──
function openListModal(insc, existingPrice = null) {
  state.listingTarget = insc;

  $('#list-modal-name').textContent = `Inscription #${formatNumber(insc.inscriptionNumber)}`;
  $('#list-modal-id').textContent = insc.inscriptionId;

  const thumb = $('#list-modal-thumb');
  thumb.innerHTML = buildPreviewHtml(insc, 'thumb');

  listPriceInput.value = existingPrice || '';
  listPriceInput.disabled = false;
  listPriceHint.textContent = '';
  listStatus.className = 'buy-status hidden';
  listStatus.textContent = '';
  listConfirmBtn.disabled = false;

  const btnText = existingPrice ? 'Update Listing' : 'Sign & List';
  listConfirmBtn.innerHTML = `
    <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2v20M2 12h20"/>
    </svg>
    ${btnText}
  `;

  listModal.classList.remove('hidden');
  listPriceInput.focus();
}

function closeListModal() {
  listModal.classList.add('hidden');
  state.listingTarget = null;
}

function setListStatus(type, message) {
  listStatus.className = `buy-status status-${type}`;
  listStatus.textContent = message;
  listStatus.classList.remove('hidden');
}

async function confirmListing() {
  const insc = state.listingTarget;
  if (!insc) return;

  const price = parseInt(listPriceInput.value);
  if (isNaN(price) || price < 546) {
    listPriceHint.textContent = 'Price must be at least 546 sats (dust limit)';
    listPriceHint.style.color = 'var(--danger)';
    return;
  }

  // Parse inscription UTXO from location (txid:vout:offset)
  const locParts = (insc.output || insc.location || '').split(':');
  const txid = locParts[0];
  const vout = parseInt(locParts[1]);
  if (!txid || txid.length !== 64 || isNaN(vout)) {
    setListStatus('error', 'Cannot parse inscription UTXO location.');
    return;
  }

  const inscriptionAddress = insc.address || state.address;
  const sellerAddress = inscriptionAddress;
  const utxoValue = insc.outputValue;

  if (!utxoValue || utxoValue <= 0) {
    setListStatus('error', 'Cannot determine inscription UTXO value. Try refreshing.');
    return;
  }

  console.log(`Listing: ${insc.inscriptionId}, address=${inscriptionAddress}, utxo=${txid}:${vout}, value=${utxoValue}`);

  listConfirmBtn.disabled = true;
  listPriceInput.disabled = true;
  setListStatus('pending', 'Building PSBT...');

  try {
    // Step 1: Build the seller PSBT
    const psbtHex = PSBT.buildSellerPsbt({
      txid,
      vout,
      utxoValue,
      inscriptionAddress,
      sellerAddress,
      priceSats: price,
    });

    console.log('Seller PSBT built:', psbtHex.length / 2, 'bytes');
    setListStatus('pending', 'Requesting wallet signature (SINGLE|ANYONECANPAY)...');

    // Step 2: Sign with UniSat — SIGHASH_SINGLE|ANYONECANPAY (0x83)
    const signedPsbtHex = await window.unisat.signPsbt(psbtHex, {
      autoFinalized: true,
      toSignInputs: [{
        index: 0,
        address: inscriptionAddress,
        sighashTypes: [0x83],
      }],
    });

    console.log('Signed PSBT:', signedPsbtHex.length / 2, 'bytes');
    setListStatus('pending', 'Extracting signature...');

    // Step 3: Extract and verify the signature
    const sigHex = PSBT.extractSignature(signedPsbtHex);
    const verification = PSBT.verifySellerSig(sigHex);

    if (!verification.valid) {
      setListStatus('error', `Signature invalid: ${verification.error}`);
      listConfirmBtn.disabled = false;
      listPriceInput.disabled = false;
      return;
    }

    console.log(`Seller sig: ${sigHex.slice(0, 16)}...${sigHex.slice(-4)} (${verification.length} bytes, sighash 0x${verification.sighash})`);

    // Step 4: Save listing with signature
    const listing = {
      inscriptionId: insc.inscriptionId,
      inscriptionNumber: insc.inscriptionNumber,
      contentType: insc.contentType || '',
      outputValue: insc.outputValue,
      location: `${txid}:${vout}`,
      priceSats: price,
      sellerAddress,
      sellerSigHex: sigHex,
      signedPsbtHex,
      createdAt: new Date().toISOString(),
    };

    await addListing(listing);
    setListStatus('success', `Signed! Sig: ...${sigHex.slice(-8)} (0x83)`);

    // Brief pause to show success, then close
    setTimeout(async () => {
      closeListModal();
      await refreshMyGrid();
      await updateStatsUI();
      await updateMarketBadge();
    }, 800);

  } catch (err) {
    console.error('Listing sign error:', err);
    const msg = (err.message || '').toLowerCase();
    if (err.code === 4001) {
      setListStatus('error', 'Signing rejected by user.');
    } else if (msg.includes('invalid psbt') || msg.includes('deserialize')) {
      setListStatus('error', 'Invalid PSBT — your wallet may not support this inscription\'s address type. Check console for details.');
      console.error('PSBT debug:', { inscriptionAddress, utxoValue, txid, vout, price });
    } else {
      setListStatus('error', err.message || 'Failed to sign PSBT.');
    }
    listConfirmBtn.disabled = false;
    listPriceInput.disabled = false;
  }
}

// ── Rendering: Market ──
async function renderMarket() {
  const listings = await getListings();
  marketGrid.innerHTML = '';

  marketTotalLabel.textContent = `${listings.length} listing${listings.length !== 1 ? 's' : ''}`;

  if (listings.length === 0) {
    marketEmpty.classList.remove('hidden');
    marketGrid.classList.add('hidden');
    return;
  }

  marketEmpty.classList.add('hidden');
  marketGrid.classList.remove('hidden');

  const listingsMap = new Map(listings.map(l => [l.inscriptionId, l]));

  listings.forEach((listing, idx) => {
    const card = document.createElement('div');
    card.className = 'inscription-card';
    card.style.animationDelay = `${idx * 0.03}s`;

    const contentType = listing.contentType || '';
    const shortType = contentType.split('/').pop() || '?';
    const isOwnListing = state.address && listing.sellerAddress === state.address;

    card.innerHTML = `
      <div class="card-preview">
        ${buildPreviewHtml(listing)}
        <span class="card-content-type">${shortType}</span>
      </div>
      <div class="card-body">
        <div class="card-number">#${formatNumber(listing.inscriptionNumber)}</div>
        <div class="card-id">${listing.inscriptionId}</div>
        <div class="market-seller">${isOwnListing ? 'You' : truncateAddress(listing.sellerAddress)}</div>
      </div>
      <div class="market-card-price">
        <div>
          <div class="market-price-value">${formatNumber(listing.priceSats)} sats</div>
          <div class="market-price-label">${satsToBtc(listing.priceSats)}</div>
        </div>
        ${isOwnListing
          ? `<button class="btn btn-danger btn-sm market-cancel-btn" data-id="${listing.inscriptionId}">Cancel</button>`
          : `<button class="btn btn-primary btn-sm market-buy-btn" data-id="${listing.inscriptionId}">Buy Now</button>`
        }
      </div>
    `;

    card.querySelector('.card-preview').addEventListener('click', () => openDetail(listing, 'market'));
    card.querySelector('.card-body').addEventListener('click', () => openDetail(listing, 'market'));

    marketGrid.appendChild(card);
  });

  document.querySelectorAll('.market-cancel-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      await removeListing(btn.dataset.id);
      await renderMarket();
      await updateMarketBadge();
      await updateStatsUI();
      if (state.connected) await refreshMyGrid();
    };
  });

  document.querySelectorAll('.market-buy-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const listing = listingsMap.get(btn.dataset.id);
      if (listing) openBuyModal(listing);
    };
  });
}

// ── Buy Modal ──
function openBuyModal(listing) {
  if (!state.connected) {
    if (!hasUnisat()) {
      noWalletModal.classList.remove('hidden');
      return;
    }
    connectWallet().then(() => {
      if (state.connected) openBuyModal(listing);
    });
    return;
  }

  if (state.address === listing.sellerAddress) {
    alert('You cannot buy your own listing.');
    return;
  }

  state.buyTarget = listing;

  $('#buy-modal-name').textContent = `Inscription #${formatNumber(listing.inscriptionNumber)}`;
  $('#buy-modal-id').textContent = listing.inscriptionId;
  $('#buy-modal-thumb').innerHTML = buildPreviewHtml(listing, 'thumb');

  const total = listing.priceSats + EST_FEE;

  $('#buy-price-value').textContent = `${formatNumber(listing.priceSats)} sats`;
  $('#buy-fee-value').textContent = `~${formatNumber(EST_FEE)} sats`;
  $('#buy-total-value').textContent = `~${formatNumber(total)} sats`;
  $('#buy-seller-value').textContent = listing.sellerAddress;

  buyStatus.className = 'buy-status hidden';
  buyStatus.textContent = '';
  buyConfirmBtn.disabled = false;
  buyConfirmBtn.innerHTML = `
    <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M20 6L9 17l-5-5"/>
    </svg>
    Confirm Purchase
  `;

  buyModal.classList.remove('hidden');
}

function closeBuyModal() {
  buyModal.classList.add('hidden');
  state.buyTarget = null;
}

async function fetchBuyerUtxos(address) {
  // Fetch all UTXOs from mempool.space
  const resp = await fetch(`https://mempool.space/api/address/${address}/utxo`);
  if (!resp.ok) throw new Error(`UTXO fetch failed: ${resp.status}`);
  const utxos = await resp.json();

  // Get all inscription UTXOs from UniSat to avoid spending them
  const inscriptionOutputs = new Set();
  try {
    let offset = 0;
    const size = 100;
    while (true) {
      const result = await window.unisat.getInscriptions(offset, size);
      if (!result || !result.list || result.list.length === 0) break;
      for (const insc of result.list) {
        const loc = insc.output || insc.location || '';
        const parts = loc.split(':');
        if (parts.length >= 2) {
          inscriptionOutputs.add(`${parts[0]}:${parts[1]}`);
        }
      }
      offset += result.list.length;
      if (offset >= (result.total || 0)) break;
    }
  } catch (e) {
    console.warn('Could not fetch inscriptions for UTXO filtering:', e);
  }

  console.log(`Filtering out ${inscriptionOutputs.size} inscription UTXOs`);

  // Filter: confirmed, not an inscription UTXO
  return utxos
    .filter(u => u.status && u.status.confirmed && !inscriptionOutputs.has(`${u.txid}:${u.vout}`))
    .sort((a, b) => a.value - b.value);
}

async function executeBuy() {
  const listing = state.buyTarget;
  if (!listing || !state.connected) return;

  // Validate listing has seller signature
  if (!listing.sellerSigHex || !listing.signedPsbtHex) {
    setBuyStatus('error', 'Listing is missing seller signature. Cannot complete purchase.');
    return;
  }

  buyConfirmBtn.disabled = true;

  // Parse inscription UTXO from listing
  const [inscTxid, inscVoutStr] = listing.location.split(':');
  const inscVout = parseInt(inscVoutStr);
  const inscUtxoValue = listing.outputValue;
  const priceSats = listing.priceSats;

  // Buyer pays: price + fee. Postage comes from inscription UTXO.
  const totalNeeded = priceSats + EST_FEE + 546;

  try {
    // Step 1: Find buyer UTXO (>= price + fee + dust for change)
    setBuyStatus('pending', 'Finding payment UTXO...');
    const utxos = await fetchBuyerUtxos(state.address);
    const buyerUtxo = utxos.find(u => u.value >= totalNeeded);

    if (!buyerUtxo) {
      setBuyStatus('error', `No UTXO >= ${formatNumber(totalNeeded)} sats found. Largest: ${utxos.length > 0 ? formatNumber(utxos[utxos.length - 1].value) : 0} sats`);
      buyConfirmBtn.disabled = false;
      return;
    }

    console.log(`Buyer UTXO: ${buyerUtxo.txid}:${buyerUtxo.vout} (${buyerUtxo.value} sats)`);

    // Step 2: Calculate change
    // Inscription UTXO (postage) funds the delivery output, so buyer only covers price + fee
    const changeSats = buyerUtxo.value - priceSats - EST_FEE;

    if (changeSats < 546) {
      setBuyStatus('error', `Change too small (${changeSats} sats). Need a larger UTXO.`);
      buyConfirmBtn.disabled = false;
      return;
    }

    console.log(`Change: ${changeSats} sats, Fee: ${EST_FEE} sats`);

    // Step 3: Build signing PSBT (dummy input 0 hides inscription from UniSat)
    setBuyStatus('pending', 'Building transaction...');
    const signingPsbtHex = PSBT.buildBuyerSigningPsbt({
      buyerTxid: buyerUtxo.txid,
      buyerVout: buyerUtxo.vout,
      buyerUtxoValue: buyerUtxo.value,
      buyerAddress: state.address,
      priceSats,
      sellerAddress: listing.sellerAddress,
      inscUtxoValue,
      deliveryAddress: state.address,
      changeSats,
    });

    console.log('Signing PSBT built:', signingPsbtHex.length / 2, 'bytes');

    // Step 4: Buyer signs input 1 with SIGHASH_ALL|ANYONECANPAY (0x81)
    // Sig commits to: buyer's input + all outputs (not input 0 data)
    // Use autoFinalized: false — we extract the sig ourselves
    setBuyStatus('pending', 'Sign your payment input...');
    const buyerSignedHex = await window.unisat.signPsbt(signingPsbtHex, {
      autoFinalized: false,
      toSignInputs: [{
        index: 1,
        address: state.address,
        sighashTypes: [0x81],
      }],
    });

    console.log('Buyer signed PSBT:', buyerSignedHex.length / 2, 'bytes');
    console.log('Signed PSBT hex (first 200 chars):', buyerSignedHex.slice(0, 200));

    // Step 5: Extract buyer's witness from signed PSBT
    setBuyStatus('pending', 'Assembling final transaction...');
    const buyerWitnessHex = PSBT.extractWitness(buyerSignedHex, 1);
    if (!buyerWitnessHex) {
      console.error('Full signed PSBT hex:', buyerSignedHex);
      throw new Error('Failed to extract buyer witness from signed PSBT');
    }

    console.log('Buyer witness extracted:', buyerWitnessHex.length / 2, 'bytes');

    // Step 6: Build final PSBT with real inscription input + both signatures
    const finalPsbtHex = PSBT.buildFinalPsbt({
      inscTxid,
      inscVout,
      inscUtxoValue,
      inscriptionAddress: listing.sellerAddress,
      buyerTxid: buyerUtxo.txid,
      buyerVout: buyerUtxo.vout,
      buyerUtxoValue: buyerUtxo.value,
      buyerAddress: state.address,
      priceSats,
      sellerAddress: listing.sellerAddress,
      deliveryAddress: state.address,
      changeSats,
      sellerSigHex: listing.sellerSigHex,
      buyerWitnessHex,
    });

    console.log('Final PSBT with both sigs:', finalPsbtHex.length / 2, 'bytes');

    // Step 6: Broadcast via UniSat
    setBuyStatus('pending', 'Broadcasting transaction...');
    const txid = await window.unisat.pushPsbt(finalPsbtHex);

    console.log('Broadcast txid:', txid);

    setBuyStatusHtml('success', `Purchase complete! <a href="https://memepool.space/tx/${txid}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">TX: ${txid.slice(0, 12)}...${txid.slice(-8)}</a>`);
    buyConfirmBtn.innerHTML = `
      <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20 6L9 17l-5-5"/>
      </svg>
      Done
    `;

    await markListingSold(listing.inscriptionId);
    await updateMarketBadge();

    buyConfirmBtn.onclick = async () => {
      closeBuyModal();
      await renderMarket();
      buyConfirmBtn.onclick = executeBuy;
    };

    await loadBalance();
  } catch (err) {
    console.error('Buy error:', err);
    if (err.code === 4001) {
      setBuyStatus('error', 'Transaction rejected by user.');
    } else {
      setBuyStatus('error', err.message || 'Transaction failed.');
    }
    buyConfirmBtn.disabled = false;
  }
}

function setBuyStatus(type, message) {
  buyStatus.className = `buy-status status-${type}`;
  buyStatus.textContent = message;
  buyStatus.classList.remove('hidden');
}

function setBuyStatusHtml(type, html) {
  buyStatus.className = `buy-status status-${type}`;
  buyStatus.innerHTML = html;
  buyStatus.classList.remove('hidden');
}

async function updateMarketBadge() {
  const listings = await getListings();
  if (listings.length > 0) {
    marketCountBadge.textContent = listings.length;
    marketCountBadge.classList.remove('hidden');
  } else {
    marketCountBadge.classList.add('hidden');
  }
}

// ── Detail Modal ──
async function openDetail(insc, source) {
  const contentType = insc.contentType || '';
  const isImage = contentType.startsWith('image/');
  const isHtml = contentType.startsWith('text/html');
  const isSvg = contentType === 'image/svg+xml';

  const inscriptionId = insc.inscriptionId;
  const contentUrl = `${ORD_CONTENT_BASE}/content/${inscriptionId}`;
  const previewUrl = `${ORD_CONTENT_BASE}/preview/${inscriptionId}`;

  const preview = $('#detail-preview');
  if (isImage && !isSvg) {
    preview.innerHTML = `<img src="${contentUrl}" alt="Inscription #${insc.inscriptionNumber}">`;
  } else if (isSvg || isHtml) {
    preview.innerHTML = `<iframe src="${previewUrl}" sandbox="allow-scripts" title="Inscription"></iframe>`;
  } else {
    preview.innerHTML = `<div class="preview-placeholder" style="padding:2rem;color:var(--text-muted);">${contentType || 'No preview'}</div>`;
  }

  $('#detail-title').textContent = `Inscription #${formatNumber(insc.inscriptionNumber)}`;
  $('#detail-id').textContent = inscriptionId;
  $('#detail-number').textContent = formatNumber(insc.inscriptionNumber);
  $('#detail-content-type').textContent = contentType || '—';
  $('#detail-content-length').textContent = formatBytes(insc.contentLength);

  const genesisTx = inscriptionId.replace(/i\d+$/, '');
  $('#detail-genesis-tx').textContent = genesisTx;

  const location = insc.location || '—';
  $('#detail-location').textContent = location;

  $('#detail-output-value').textContent = insc.outputValue ? `${formatNumber(insc.outputValue)} sats` : '—';
  $('#detail-offset').textContent = insc.offset != null ? formatNumber(insc.offset) : '—';

  $('#detail-ord-link').href = `${ORD_CONTENT_BASE}/inscription/${inscriptionId}`;

  // Show listing info if listed
  const listing = await getListing(inscriptionId);
  const listingBadge = $('#detail-listing-badge');
  const detailActions = $('#detail-actions');
  const sellerField = $('#detail-seller-field');

  if (listing) {
    listingBadge.classList.remove('hidden');
    $('#detail-listing-price').textContent = `${formatNumber(listing.priceSats)} sats`;
    sellerField.style.display = '';
    $('#detail-seller').textContent = listing.sellerAddress;

    const isOwn = state.address && listing.sellerAddress === state.address;
    detailActions.innerHTML = `
      <a id="detail-ord-link" class="btn btn-ghost" href="${ORD_CONTENT_BASE}/inscription/${inscriptionId}" target="_blank" rel="noopener">View on Explorer</a>
      ${isOwn
        ? `<button class="btn btn-danger detail-cancel-btn" data-id="${inscriptionId}" style="margin-top:0.5rem;width:100%;justify-content:center;">Cancel Listing</button>`
        : `<button class="btn btn-primary detail-buy-btn" data-id="${inscriptionId}" style="margin-top:0.5rem;width:100%;justify-content:center;">Buy for ${formatNumber(listing.priceSats)} sats</button>`
      }
    `;

    const cancelBtn = detailActions.querySelector('.detail-cancel-btn');
    if (cancelBtn) {
      cancelBtn.onclick = async () => {
        await removeListing(inscriptionId);
        closeDetail();
        if (state.activeTab === 'market') await renderMarket();
        else await refreshMyGrid();
        await updateMarketBadge();
        await updateStatsUI();
      };
    }

    const buyBtn = detailActions.querySelector('.detail-buy-btn');
    if (buyBtn) {
      buyBtn.onclick = () => {
        closeDetail();
        openBuyModal(listing);
      };
    }
  } else {
    listingBadge.classList.add('hidden');
    sellerField.style.display = 'none';

    const isOwn = source === 'wallet';
    detailActions.innerHTML = `
      <a class="btn btn-ghost" href="${ORD_CONTENT_BASE}/inscription/${inscriptionId}" target="_blank" rel="noopener">View on Explorer</a>
      ${isOwn ? `<button class="btn btn-primary detail-list-btn" style="margin-top:0.5rem;width:100%;justify-content:center;">List for Sale</button>` : ''}
    `;

    const listBtn = detailActions.querySelector('.detail-list-btn');
    if (listBtn) {
      listBtn.onclick = () => {
        closeDetail();
        const fullInsc = state.inscriptions.find(i => i.inscriptionId === inscriptionId);
        if (fullInsc) openListModal(fullInsc);
      };
    }
  }

  detailModal.classList.remove('hidden');
}

function closeDetail() {
  detailModal.classList.add('hidden');
  $('#detail-preview').innerHTML = '';
}

// ── UI Updates ──
function updateWalletUI() {
  if (state.connected) {
    connectBtn.innerHTML = `
      <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
      <span>Logout</span>
    `;
    connectBtn.classList.remove('btn-primary');
    connectBtn.classList.add('btn-ghost');
    walletInfo.classList.remove('hidden');
    addressBadge.textContent = truncateAddress(state.address);
  }
}

function disconnectWallet() {
  resetWalletState();
  if (state.activeTab === 'my-inscriptions') showView('hero');
}

function updateBalanceUI() {
  if (state.balance) {
    const totalSats = state.balance.total || 0;
    balanceBadge.textContent = formatNumber(totalSats) + ' sats';
    $('#stat-balance').textContent = formatNumber(totalSats);
  }
}

async function updateStatsUI() {
  $('#stat-total').textContent = formatNumber(state.total);
  $('#stat-listed').textContent = formatNumber(await getMyListedCount());
  $('#stat-address').textContent = truncateAddress(state.address);
  if (state.balance) {
    $('#stat-balance').textContent = formatNumber(state.balance.total || 0);
  }
}

function resetWalletState() {
  state.connected = false;
  state.address = null;
  state.balance = null;
  state.inscriptions = [];
  walletInfo.classList.add('hidden');
  connectBtn.innerHTML = `
    <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="6" width="20" height="12" rx="2"/>
      <path d="M22 10h-4a2 2 0 000 4h4"/>
    </svg>
    <span>Connect Wallet</span>
  `;
  connectBtn.classList.add('btn-primary');
  connectBtn.classList.remove('btn-ghost');

  if (state.activeTab === 'my-inscriptions') showView('hero');
}

// ── Event Listeners ──
connectBtn.addEventListener('click', () => {
  if (state.connected) disconnectWallet();
  else connectWallet();
});
heroConnectBtn.addEventListener('click', connectWallet);

tabNav.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (btn) switchTab(btn.dataset.tab);
});

refreshBtn.addEventListener('click', () => {
  if (state.connected) {
    loadBalance();
    loadInscriptions(true);
  }
});

loadMoreBtn.addEventListener('click', () => {
  if (state.connected && !state.loading) {
    loadInscriptions(false);
  }
});

listConfirmBtn.addEventListener('click', confirmListing);
listPriceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmListing();
});
listPriceInput.addEventListener('input', () => {
  const v = parseInt(listPriceInput.value);
  if (listPriceInput.value && !isNaN(v) && v >= 546) {
    listPriceHint.textContent = satsToBtc(v);
    listPriceHint.style.color = 'var(--text-muted)';
  } else if (listPriceInput.value) {
    listPriceHint.textContent = 'Min 546 sats';
    listPriceHint.style.color = 'var(--danger)';
  } else {
    listPriceHint.textContent = '';
  }
});

listModalClose.addEventListener('click', closeListModal);
listModal.addEventListener('click', (e) => {
  if (e.target === listModal) closeListModal();
});

buyConfirmBtn.addEventListener('click', executeBuy);
buyModalClose.addEventListener('click', closeBuyModal);
buyModal.addEventListener('click', (e) => {
  if (e.target === buyModal) closeBuyModal();
});

detailClose.addEventListener('click', closeDetail);
detailModal.addEventListener('click', (e) => {
  if (e.target === detailModal) closeDetail();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!buyModal.classList.contains('hidden')) closeBuyModal();
    else if (!listModal.classList.contains('hidden')) closeListModal();
    else if (!detailModal.classList.contains('hidden')) closeDetail();
  }
});

// ── Listen for account changes ──
if (hasUnisat()) {
  try {
    window.unisat.on('accountsChanged', async (accounts) => {
      if (accounts.length === 0) {
        resetWalletState();
      } else {
        state.address = accounts[0];
        updateWalletUI();
        await loadBalance();
        if (state.activeTab === 'my-inscriptions') {
          await loadInscriptions(true);
        }
      }
    });
  } catch (e) {
    // Older unisat versions may not support event listeners
  }
}

// ── Init ──
async function init() {
  await updateMarketBadge();

  if (!hasUnisat()) return;

  try {
    const accounts = await window.unisat.getAccounts();
    if (accounts && accounts.length > 0) {
      state.address = accounts[0];
      state.connected = true;
      updateWalletUI();
      await loadBalance();
      await loadInscriptions(true);
    }
  } catch (e) {
    // Not connected yet, show hero
  }
}

init();
