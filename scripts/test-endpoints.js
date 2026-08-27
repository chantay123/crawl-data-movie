/**
 * Script tiện ích - Test các endpoint API đang hoạt động
 *
 * Chạy: node scripts/test-endpoints.js
 *
 * Vì các nguồn API phim hay đổi domain, script này giúp
 * bạn kiểm tra nhanh nguồn nào còn sống.
 */

const axios = require('axios');

const CANDIDATES = [
  // OPhim - các subdomain thường gặp
  { source: 'ophim', urls: [
    'https://ophim1.com/v1/api/danh-sach/phim-moi?page=1',
    'https://ophim.tv/v1/api/danh-sach/phim-moi?page=1',
    'https://www.ophim.tv/v1/api/danh-sach/phim-moi?page=1',
  ]},
  // Nguonc
  { source: 'nguonc', urls: [
    'https://phim.nguonc.com/api/danh-sach/phim-moi?page=1',
    'https://nguonc.com/api/danh-sach/phim-moi?page=1',
    'https://www.nguonc.com/api/danh-sach/phim-moi?page=1',
  ]},
  // KKPhim
  { source: 'kkphim', urls: [
    'https://kkphim.com/api/danh-sach/phim-moi?page=1',
    'https://api.kkphim.com/danh-sach/phim-moi?page=1',
  ]},
];

async function probe(url) {
  try {
    const r = await axios.get(url, { timeout: 10000, validateStatus: () => true });
    const items = r.data?.data?.items || r.data?.items || [];
    if (r.status === 200 && items.length > 0) {
      return { ok: true, status: r.status, count: items.length, sample: items[0] };
    }
    return { ok: false, status: r.status, msg: r.data?.message || 'no items' };
  } catch (e) {
    return { ok: false, status: e.response?.status || e.code, msg: e.message };
  }
}

async function main() {
  console.log('Probing movie API endpoints...\n');
  for (const { source, urls } of CANDIDATES) {
    console.log(`=== ${source.toUpperCase()} ===`);
    for (const url of urls) {
      const res = await probe(url);
      if (res.ok) {
        console.log(`✅ ${url}`);
        console.log(`   status=${res.status}, items=${res.count}, sample=${res.sample.slug}`);
      } else {
        console.log(`❌ ${url} -> ${res.status} (${res.msg})`);
      }
    }
    console.log('');
  }
  console.log('\nUpdate .env with WORKING URLs (set OPHIM_BASE_URL, KKPHIM_BASE_URL, NGUONC_BASE_URL).');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
