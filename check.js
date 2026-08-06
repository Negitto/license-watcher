// 鮫洲試験場 学科試験 空き状況チェッカー
// 警視庁 運転免許手続予約サイトの「空き状況カレンダー」を自動巡回し、
// 各日付・各時間帯の残席数を記録し、空きが見つかったら通知する

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TOP_URL = 'https://license-test.tokyo-madoguchi-yoyaku.com/police-pref-tokyo/index.html?lang=ja';

// 「空き状況カレンダー」の画面に直接アクセスできるURL
const CALENDAR_URL = 'https://license-test.tokyo-madoguchi-yoyaku.com/police-pref-tokyo/calendar/01/html/main.html?lang=ja';

// 監視対象の期間 (この範囲内の日付だけ記録・通知する)
const TARGET_LIMIT_DATE = '2026-09-03';

// 履歴を保存するCSVファイル (実行するたびに1行ずつ追記される)
const HISTORY_FILE = path.join(__dirname, 'data', 'history.csv');
const HISTORY_HEADER = 'checked_at,date,slot,remaining,is_full\n';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(CALENDAR_URL, { waitUntil: 'networkidle', referer: TOP_URL });

    // Step1: 受験項目「教習所卒業等」(typeDetailChoice=11)
    await page.waitForSelector('input[name="typeDetailChoice"][value="11"]', { timeout: 15000, state: 'attached' });
    await clickByRadio(page, 'typeDetailChoice', '11');

    // Step2: 免許保有形態「免許証のみ」(newLicenseChoice=1)
    await clickByRadio(page, 'newLicenseChoice', '1');

    // Step3: 受験場所「鮫洲試験場」を選択
    await page.waitForSelector('#placeChoiceArea:not(.display_none)', { timeout: 15000 });
    await page.waitForSelector('input[name="placeChoice"][value="280:鮫洲試験場"]', { timeout: 10000, state: 'attached' });
    await clickByRadio(page, 'placeChoice', '280:鮫洲試験場');

    // 「進む」ボタン (nextPageBtn03) が有効化されるまで待つ
    await page.waitForFunction(() => {
      const btn = document.querySelector('#nextPageBtn03');
      return btn && getComputedStyle(btn).display !== 'none';
    }, { timeout: 20000 });
    await page.$eval('#nextPageBtn03', el => el.click());

    // カレンダー表示まで待機
    await page.waitForSelector('#datepicker .ui-datepicker-calendar', { timeout: 15000 });

    // 全ての結果(満席含む)をここに集める。履歴用と通知用の両方に使う
    const allResults = [];

    // TARGET_LIMIT_DATEの月まで、カレンダーの「次月」を辿りながら確認する
    let safety = 0; // 無限ループ防止
    while (safety < 6) {
      safety++;
      const availableDates = await getAvailableDates(page);

      for (const d of availableDates) {
        if (d.isoDate > TARGET_LIMIT_DATE) continue;

        await clickDate(page, d);
        await page.waitForSelector('#visitTimeChoiceList', { timeout: 10000 });
        const slots = await getTimeSlots(page);

        for (const s of slots) {
          allResults.push({ date: d.isoDate, ...s });
        }
      }

      // 表示中のカレンダーの年月を取得し、対象月を超えていれば終了
      const shownMonth = await getShownYearMonth(page);
      const limitMonth = TARGET_LIMIT_DATE.slice(0, 7); // 'YYYY-MM'
      if (shownMonth >= limitMonth) break;

      // 次月へ移動できるか確認して移動
      const movedToNext = await goToNextMonth(page);
      if (!movedToNext) break;
    }

    // 履歴ファイルに全件を追記(満席含む。後から推移を見るため)
    appendHistory(allResults);

    // 通知用は「空きがある(残り1名以上)」ものだけに絞る
    const openings = groupByDate(allResults.filter(r => r.remaining > 0));

    if (openings.length > 0) {
      await notify(openings);
      console.log('空きを検知しました:', JSON.stringify(openings, null, 2));
    } else {
      console.log(`マスター、報告です。条件に合致する空き枠はありませんでした。(確認日時: ${new Date().toISOString()})`);
    }

    // 今回確認した内容を一覧表示(座席数の詳細確認用)
    console.log('--- 今回チェックした全件 ---');
    allResults.forEach(r => {
      console.log(`${r.date}  ${r.text}`);
    });
  } catch (err) {
    console.error('チェック中にエラーが発生しました:', err);
    await notifyError(err).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

// name/valueで指定したラジオボタンを囲むlabel要素をクリックする
async function clickByRadio(page, name, value) {
  const input = page.locator(`input[name="${name}"][value="${value}"]`).first();
  const label = input.locator('xpath=ancestor::label[1]');
  if (await label.count() > 0) {
    await label.evaluate(el => el.click());
  } else {
    const span = input.locator('xpath=following-sibling::span[contains(@class,"radio2label")][1]');
    await span.evaluate(el => el.click());
  }
}

// カレンダーに表示されている「クリック可能な日付」を取得
async function getAvailableDates(page) {
  return await page.evaluate(() => {
    const results = [];
    const cells = document.querySelectorAll('#datepicker td:not(.ui-datepicker-unselectable)');
    cells.forEach(td => {
      const link = td.querySelector('a[data-date]');
      if (!link) return;
      const day = link.getAttribute('data-date');
      const month = td.getAttribute('data-month'); // 0-indexed
      const year = td.getAttribute('data-year');
      if (day && month !== null && year) {
        const mm = String(Number(month) + 1).padStart(2, '0');
        const dd = String(Number(day)).padStart(2, '0');
        results.push({ day, month, year, isoDate: `${year}-${mm}-${dd}` });
      }
    });
    return results;
  });
}

// 現在カレンダーに表示されている年月を 'YYYY-MM' で取得
async function getShownYearMonth(page) {
  return await page.evaluate(() => {
    const year = document.querySelector('#datepicker .ui-datepicker-year')?.textContent?.trim();
    const monthText = document.querySelector('#datepicker .ui-datepicker-month')?.textContent?.trim();
    // 月名は "8月" のような表記なので数字だけ取り出す
    const monthNum = monthText ? monthText.replace(/[^0-9]/g, '').padStart(2, '0') : '00';
    return `${year}-${monthNum}`;
  });
}

// カレンダーの「次月」ボタンを押す。押せなければ false を返す
async function goToNextMonth(page) {
  const clicked = await page.evaluate(() => {
    const nextBtn = document.querySelector('#datepicker .ui-datepicker-next');
    if (!nextBtn || nextBtn.classList.contains('ui-state-disabled')) return false;
    nextBtn.click();
    return true;
  });
  if (clicked) {
    await page.waitForTimeout(500);
  }
  return clicked;
}

// 指定した日付のセルをクリックする
async function clickDate(page, d) {
  const selector = `#datepicker td[data-month="${d.month}"][data-year="${d.year}"] a[data-date="${d.day}"]`;
  await page.$eval(selector, el => el.click());
  await page.waitForTimeout(800);
}

// 受付時間リストから「残り○名」を抽出
async function getTimeSlots(page) {
  return await page.evaluate(() => {
    const labels = document.querySelectorAll('#visitTimeChoiceList label');
    const out = [];
    labels.forEach(label => {
      const text = label.textContent.trim();
      const match = text.match(/残り\s*(\d+)\s*名/);
      const remaining = match ? Number(match[1]) : 0;
      out.push({ text, remaining });
    });
    return out;
  });
}

// 日付ごとにまとめる (通知メッセージ用)
function groupByDate(flatResults) {
  const map = new Map();
  for (const r of flatResults) {
    if (!map.has(r.date)) map.set(r.date, []);
    map.get(r.date).push(r);
  }
  return Array.from(map.entries()).map(([date, slots]) => ({ date, slots }));
}

// 履歴CSVに追記する (data/history.csv)
function appendHistory(flatResults) {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, HISTORY_HEADER);

  const checkedAt = new Date().toISOString();
  const lines = flatResults.map(r => {
    const isFull = r.remaining > 0 ? 0 : 1;
    // CSVなのでカンマ・改行を含む可能性のあるテキストはダブルクオートで囲む
    const safeText = `"${r.text.replace(/"/g, '""')}"`;
    return `${checkedAt},${r.date},${safeText},${r.remaining},${isFull}`;
  });
  if (lines.length > 0) {
    fs.appendFileSync(HISTORY_FILE, lines.join('\n') + '\n');
  }
}

// 通知処理 (例: Pushover。環境変数が無ければスキップ)
async function notify(openings) {
  const details = openings
    .map(o => `${o.date}:\n` + o.slots.filter(s => s.remaining > 0).map(s => '  ' + s.text).join('\n'))
    .join('\n');

  // マスターへの報告、という体で通知文を組み立てる
  const message = `マスター、報告です。\n条件に合致する空き枠を検知しました。\n\n${details}\n\nご確認を推奨します。`;

  console.log('=== 空き通知 ===\n' + message);

  if (process.env.PUSHOVER_TOKEN && process.env.PUSHOVER_USER) {
    await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: process.env.PUSHOVER_TOKEN,
        user: process.env.PUSHOVER_USER,
        title: '報告：空き枠を検知しました',
        message,
        priority: '1',
      }),
    });
  }
}

// エラー発生時も同じ口調で通知する(冷静に、事実だけを告げる)
async function notifyError(err) {
  const message = `マスター、報告です。\n監視処理中にエラーが発生しました。非効率的な状態です。\n\n${err.message || err}`;

  console.log('=== エラー通知 ===\n' + message);

  if (process.env.PUSHOVER_TOKEN && process.env.PUSHOVER_USER) {
    await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: process.env.PUSHOVER_TOKEN,
        user: process.env.PUSHOVER_USER,
        title: '報告：エラーが発生しました',
        message,
        priority: '0',
      }),
    });
  }
}

main();
