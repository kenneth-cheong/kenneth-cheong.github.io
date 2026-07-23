const fs = require('fs');
eval(fs.readFileSync('recon.js', 'utf8'));
const all = JSON.parse(fs.readFileSync('all_projects.json', 'utf8'));

function flat(sc) {
  const out = [];
  (sc.platforms || []).forEach(p => (p.posts || []).forEach((po, i) => {
    out.push(Object.assign({}, po, { platform: p.platform, _id: srPostKey(po, p.platform, i) }));
  }));
  return out;
}

// Which live post does this tag entry refer to? Timestamp first, then caption —
// a merged entry inherits the surviving twin's timestamp, so a ts-only check
// reports false losses.
function resolves(entry, posts) {
  const e = srTsEpoch(entry.ts);
  let hit = posts.find(p => p.platform === entry.platform && srTsEpoch(p.ts) === e);
  if (hit) return hit._id;
  const k = srCaptionKey(entry.text || entry.caption);
  if (!k) return null;
  hit = posts.find(p => p.platform === entry.platform && srCaptionKey(p.text || p.caption) === k);
  return hit ? hit._id : null;
}

let fail = 0;
for (const [pid, v] of Object.entries(all)) {
  console.log('\n=== ' + (v.brand || pid) + ' — ' + v.tags.length + ' tag entries ===');
  global.cur = { tagged_posts: JSON.parse(JSON.stringify(v.tags)) };
  var cur = global.cur;
  const before = JSON.parse(JSON.stringify(v.tags));
  const allPosts = [];
  for (const [m, sc] of Object.entries(v.months)) {
    const posts = flat(sc);
    allPosts.push(...posts);
    const n = srReconcileTagIds(posts);
    const again = srReconcileTagIds(posts);
    const liveIds = new Set(posts.map(p => p._id));
    const resolved = cur.tagged_posts.filter(e => liveIds.has(e._id)).length;
    const ids = cur.tagged_posts.filter(e => liveIds.has(e._id)).map(e => e._id);
    const dup = ids.length - new Set(ids).size;
    console.log(`  ${m}: posts=${String(posts.length).padStart(3)}  reconciled=${String(n).padStart(3)}  idempotent=${again === 0}  resolved=${resolved}  dupAssign=${dup}`);
    if (again !== 0 || dup !== 0) fail++;
  }
  // every original (post, label) pair must still exist on whichever entry now
  // owns that post
  let lost = 0;
  before.forEach(t => {
    const target = resolves(t, allPosts);
    (t.labels || []).forEach(l => {
      const ok = cur.tagged_posts.some(e =>
        (e._id === target || resolves(e, allPosts) === target) && (e.labels || []).includes(l));
      if (!ok) { lost++; console.log('   LOST LABEL', t.platform, t.ts, l); }
    });
  });
  console.log('  entries ' + before.length + ' -> ' + cur.tagged_posts.length + ' (duplicates merged) | labels lost: ' + lost);
  if (lost) fail++;
}
console.log('\n' + (fail ? 'FAILURES: ' + fail : 'ALL CHECKS PASSED'));
