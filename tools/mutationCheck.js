'use strict';

/**
 * يشغّل اختبارات المحفظة على نسخة أخرى من الكود — كلُّ اختبار وحده — ليبيّن
 * أيّها يكشف العلّة فعلاً ولماذا. اختبار ينجح على الكود المعيب لا يحمي شيئاً.
 *
 *   node tools/mutationCheck.js HEAD                ← الكود المرفوع على GitHub
 *   node tools/mutationCheck.js HEAD <ملف-تعديل>    ← نفسه + تعديلات نصّية فوقه
 *   node tools/mutationCheck.js CURRENT <ملف-تعديل> ← الحالي + تعديلات
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const base = process.argv[2] || 'HEAD';
const mutations = process.argv[3];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-mut-'));
fs.cpSync(path.join(ROOT, 'server'), path.join(dir, 'server'), { recursive: true });
fs.cpSync(path.join(ROOT, 'test'), path.join(dir, 'test'), { recursive: true });
fs.cpSync(path.join(ROOT, 'public', 'js'), path.join(dir, 'public', 'js'), { recursive: true });

if (base === 'HEAD') {
  for (const f of ['store.js', 'accounts.js']) {
    fs.writeFileSync(path.join(dir, 'server', f),
      execSync(`git show HEAD:server/${f}`, { cwd: ROOT, maxBuffer: 1 << 26 }));
  }
}
if (mutations) {
  // ملف تعديلات: [{ file, find, replace }] — أو { file, fn, replace } لاستبدال دالّة كاملة
  for (const m of require(path.resolve(mutations))) {
    const p = path.join(dir, 'server', m.file);
    let s = fs.readFileSync(p, 'utf8');
    if (m.fn) {
      const a = s.indexOf(`async function ${m.fn}(`) >= 0 ? s.indexOf(`async function ${m.fn}(`) : s.indexOf(`function ${m.fn}(`);
      const b = s.indexOf('\n}\n', a) + 3;
      if (a < 0 || b < 3) throw new Error('لم يُعثر على الدالّة ' + m.fn);
      s = s.slice(0, a) + m.replace + s.slice(b);
    } else {
      if (!s.includes(m.find)) throw new Error('لم يُعثر على نصّ التعديل في ' + m.file);
      s = s.replace(m.find, m.replace);
    }
    fs.writeFileSync(p, s);
  }
}

const src = fs.readFileSync(path.join(dir, 'test', 'wallet.test.js'), 'utf8');
const names = [...src.matchAll(/^test\('([^']+)'/gm)].map((m) => m[1]);

let caught = 0;
for (const name of names) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // بعض النسخ المعيبة تُبقي مؤقّت إعادة محاولة يعيد جدولة نفسه إلى الأبد
  // فلا تنتهي العملية. التعليق فشلٌ أيضاً — نحدّه بمهلة.
  const r = spawnSync(process.execPath, ['--test', '--test-name-pattern', `^${esc}$`, 'test/wallet.test.js'],
    { cwd: dir, encoding: 'utf8', timeout: 20_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const hung = !!r.error && r.error.code === 'ETIMEDOUT';
  const failed = hung || /ℹ fail [1-9]/.test(out);
  // أوّل رسالة تأكيد — سبب الفشل الحقيقي
  const why = (out.match(/(?:AssertionError[^\n]*\n\s*\n?\s*)([^\n]+)/) || out.match(/error: '([^']+)'/) || [])[1] || '';
  if (failed) caught++;
  const reason = hung ? 'لم تنتهِ العملية خلال 20 ثانية' : why.trim().slice(0, 110);
  console.log((failed ? '✖ يكشفها  ' : '✔ تمرّ     ') + name + (failed && reason ? '\n            ↳ ' + reason : ''));
}
console.log(`\n${caught} من ${names.length} اختبار تفشل على هذه النسخة`);
fs.rmSync(dir, { recursive: true, force: true });
