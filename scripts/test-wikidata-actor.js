/**
 * Test script for Wikidata + ActorService integration
 *
 * Usage:
 *   node scripts/test-wikidata-actor.js                       # run default actors
 *   node scripts/test-wikidata-actor.js "Tom Cruise" "Scarlett Johansson"
 *
 * Mục tiêu:
 *   - Verify WikidataService có fetch được name/profileImage/gender
 *   - Verify ActorService.findOrCreateFromWikidata không ghi đè dữ liệu hợp lệ
 *   - Verify cả 3 case: tạo mới / cập nhật / không tìm thấy
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const logger = require('../src/utils/logger');
const WikidataService = require('../src/services/WikidataService');
const ActorService = require('../src/services/ActorService');
const Actor = require('../src/models/actor');

const args = process.argv.slice(2);
const DEFAULT_NAMES = [
  'Chung Shu-Kai',     // match example trong yêu cầu
  'Tom Cruise',
  'Scarlett Johansson',
  'Brad Pitt',
  'Zendaya',
  'Non Existent Actor XYZ 9999', // test "không tìm thấy"
];
const names = args.length > 0 ? args : DEFAULT_NAMES;

(async () => {
  console.log('='.repeat(60));
  console.log('WIKIDATA + ACTOR SERVICE TEST');
  console.log('='.repeat(60));

  // Bật debug log
  logger.level = 'debug';

  // 1. Test thuần WikidataService (không cần DB)
  console.log('\n--- [1/3] WikidataService.findActor() tests ---');
  for (const name of names) {
    console.log(`\n>> Query: "${name}"`);
    const result = await WikidataService.findActor(name);
    if (!result) {
      console.log('   ❌ Not found');
      continue;
    }
    console.log(`   QID           : ${result.qid}`);
    console.log(`   name          : ${result.name}`);
    console.log(`   profileImage  : ${result.profileImage ? '[OK] ' + result.profileImage.slice(0, 80) + '...' : '[MISSING]'}`);
    console.log(`   gender        : ${result.gender}`);
  }

// 2. Test ActorService (cần MongoDB)
    console.log('\n--- [2/3] Connecting MongoDB + ActorService tests ---');
    try {
      await mongoose.connect(config.mongodb.uri, {
        dbName: config.mongodb.name,
        serverSelectionTimeoutMS: 5000,
      });
      console.log(`✅ MongoDB connected: ${config.mongodb.uri} / ${config.mongodb.name}`);

      // Delay giữa các test để tránh 429 rate-limit của Wikidata
      const TEST_DELAY_MS = 4000;
      const testNames = names.slice(0, 3); // giới hạn để test chạy nhanh
      const results = [];

      for (const name of testNames) {
        console.log(`\n>> ActorService.enrichWithWikidata("${name}")`);
        const actor = await ActorService.enrichWithWikidata(name);
        if (!actor) {
          console.log('   ❌ No actor (Wikidata miss / fallback failed)');
          results.push({ name, actor: null });
        } else {
          console.log(`   _id          : ${actor._id}`);
          console.log(`   name         : ${actor.name}`);
          console.log(`   slug         : ${actor.slug}`);
          console.log(`   profileImage : ${actor.profileImage ? '[OK] ' + actor.profileImage.slice(0, 80) + '...' : '[MISSING]'}`);
          console.log(`   gender       : ${actor.gender}`);
          console.log(`   source       : ${actor.source}`);
          console.log(`   externalId   : ${actor.externalId}`);
          results.push({ name, actor });
        }
        // Wait to respect Wikidata rate-limit
        await new Promise(r => setTimeout(r, TEST_DELAY_MS));
      }

      // 3. Test idempotent update: gọi 2 lần cho actor đầu tiên tìm được
      console.log('\n--- [3/3] Idempotent update test ---');
      const successful = results.find(r => r.actor);
      if (successful) {
        const { name, actor } = successful;
        const before = {
          name: actor.name,
          profileImage: actor.profileImage,
          gender: actor.gender,
        };
        await new Promise(r => setTimeout(r, TEST_DELAY_MS));
        console.log(`>> Second call for "${name}" (should NOT overwrite valid data with null/unknown)`);
        const second = await ActorService.enrichWithWikidata(name);
        const after = second ? {
          name: second.name,
          profileImage: second.profileImage,
          gender: second.gender,
        } : null;
        const preservedName = before.name === after?.name;
        const preservedImage = before.profileImage === after?.profileImage;
        const preservedGender = before.gender === after?.gender;
        console.log(`   Before: ${JSON.stringify(before)}`);
        console.log(`   After : ${JSON.stringify(after)}`);
        console.log(`   Result: ${preservedName && preservedImage && preservedGender ? '✅ ALL fields preserved' : '⚠️ data was modified'}`);
      } else {
        console.log(`   Skipped: no actor found`);
      }

    // Cleanup: xoá các actor test nếu muốn (chỉ chạy nếu CLEANUP=1)
    if (process.env.CLEANUP === '1') {
      const slugs = names.map(n => ActorService._buildSlug(n));
      const result = await Actor.deleteMany({ slug: { $in: slugs } });
      console.log(`\n[CLEANUP] Deleted ${result.deletedCount} test actors`);
    } else {
      console.log(`\n[INFO] Set CLEANUP=1 to remove test actors from DB`);
    }
  } catch (err) {
    console.error(`❌ MongoDB test failed: ${err.message}`);
  } finally {
    await mongoose.disconnect().catch(() => {});
    console.log('\n✅ Test done');
    process.exit(0);
  }
})();