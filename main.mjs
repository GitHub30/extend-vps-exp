import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'
import fs from 'fs'
import fetch from 'node-fetch'

/**
 * 格式化中文日期为 yyyy年MM月dd日
 * 例如：2025年7月7日 => 2025年07月07日
 */
function formatChineseDate(dateStr) {
    const m = dateStr && dateStr.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!m) return dateStr || '未知';
    const [, y, mo, d] = m;
    return `${y}年${String(mo).padStart(2, '0')}月${String(d).padStart(2, '0')}日`;
}

/**
 * 计算下次可续期日期（到期日前一天）
 */
function getNextRenewAvailableDate(chineseDate) {
    const m = chineseDate.match(/(\d{4})年(\d{2})月(\d{2})日/);
    if (!m) return '未知';
    const [_, y, mo, d] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    dt.setDate(dt.getDate() - 1); // 前一天
    return `${dt.getFullYear()}年${String(dt.getMonth() + 1).padStart(2, '0')}月${String(dt.getDate()).padStart(2, '0')}日`;
}

/**
 * Sends a notification message to a Telegram chat.
 */
async function sendTelegramMessage(message) {
    const botToken = process.env.TG_BOT_TOKEN
    const chatId = process.env.TG_CHAT_ID
    if (!botToken || !chatId) {
        console.warn('Telegram bot token or chat id not set, skipping notification.')
        return
    }
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown'
            })
        })
        if (!res.ok) {
            console.error(`Failed to send Telegram message: ${res.status} ${res.statusText}`);
        }
    } catch (error) {
        console.error('Error sending Telegram message:', error);
    }
}

/**
 * Uploads a local file to a WebDAV server and returns a status message.
 * @returns {Promise<string>} A status message for the notification.
 */
async function uploadToWebDAV(localFile, remoteFile) {
    const webdavUrl = process.env.WEBDAV_URL
    const webdavUser = process.env.WEBDAV_USERNAME
    const webdavPass = process.env.WEBDAV_PASSWORD
    if (!webdavUrl || !webdavUser || !webdavPass) {
        console.log('WebDAV is not configured, skipping upload.')
        return '' // Return empty if not configured
    }

    const webdavSavePath = process.env.WEBDAV_SAVE_PATH || ''
    const remoteDir = webdavSavePath.replace(/\/$/, '')
    const fullRemotePath = remoteDir ? `${remoteDir}/${remoteFile}` : remoteFile
    const url = `${webdavUrl.replace(/\/$/, '')}/${fullRemotePath}`
    
    try {
        const fileStream = fs.createReadStream(localFile)
        const stat = fs.statSync(localFile)
        const basicAuth = Buffer.from(`${webdavUser}:${webdavPass}`).toString('base64')

        const res = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Length': stat.size, 'Authorization': `Basic ${basicAuth}` },
            body: fileStream
        })

        if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`)
        
        console.log('WebDAV upload successful:', url)
        return `✅ 录屏已成功上传到 WebDAV。\n路径: \`${fullRemotePath}\``
    } catch (error) {
        console.error('WebDAV upload error:', error.message)
        return `❌ WebDAV 上传失败: \`${error.message}\``
    }
}

/**
 * 获取当前页面所有th/td调试信息，并提取“利用期限”日期
 */
async function getExpirationDate(page) {
    try {
        const thTdList = await page.evaluate(() => {
            const results = [];
            const ths = Array.from(document.querySelectorAll('th'));
            ths.forEach(th => {
                let td = th.nextElementSibling;
                while (td && td.tagName !== 'TD') {
                    td = td.nextElementSibling;
                }
                results.push({
                    th: th.textContent.trim(),
                    td: td ? td.textContent.trim() : '无'
                });
            });
            return results;
        });

        for (const item of thTdList) {
            if (item.th === '利用期限') {
                const tdStr = item.td.replace(/\s/g, '');
                const match = tdStr.match(/\d{4}年\d{1,2}月\d{1,2}日/);
                return match ? match[0] : item.td;
            }
        }
        return '';
    } catch (error) {
        console.error("Could not evaluate getExpirationDate:", error);
        return '';
    }
}

// 生成北京时间字符串，格式 "YYYY-MM-DD HH:mm"
function getBeijingTimeString() {
    const dt = new Date(Date.now() + 8 * 60 * 60 * 1000); // UTC+8
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

// --- Main Script ---

const args = ['--no-sandbox', '--disable-setuid-sandbox']
if (process.env.PROXY_SERVER) {
    const proxy_url = new URL(process.env.PROXY_SERVER)
    proxy_url.username = ''
    proxy_url.password = ''
    args.push(`--proxy-server=${proxy_url}`.replace(/\/$/, ''))
}

const browser = await puppeteer.launch({
    defaultViewport: { width: 1280, height: 1024 },
    args,
})
const page = await browser.newPage();

await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');

page.on('console', msg => console.log('PAGE LOG:', msg.text()));
page.on('pageerror', error => console.log('PAGE ERROR:', error));

try {
    if (process.env.PROXY_SERVER) {
        const { username, password } = new URL(process.env.PROXY_SERVER)
        if (username && password) {
            await page.authenticate({ username, password })
        }
    }
} catch (e) {
    console.error('代理认证配置出错:', e)
}

const recordingPath = 'recording.webm'
const recorder = await page.screencast({ path: recordingPath })

let lastExpireDate = ''
const expireDateFile = 'expire.txt'
let infoMessage = ''
let scriptErrorMessage = ''

try {
    if (fs.existsSync(expireDateFile)) {
        lastExpireDate = fs.readFileSync(expireDateFile, 'utf8').trim()
    }

    console.log('Navigating and logging in...')
    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xserver/', { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.locator('text=ログインする').click()
    ]);

    console.log('Navigating to VPS panel...')
    await page.goto('https://secure.xserver.ne.jp/xapanel/xvps/index', { waitUntil: 'networkidle2' })

    console.log('Starting renewal process...')
    await page.locator('.contract__menuIcon').click();
    await page.locator('text=契約情報').click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    await page.waitForSelector('th', {timeout: 10000});
    await setTimeout(5000);
    
    // 只取一次到期日，整个流程复用
    const currentExpireDateRaw = await getExpirationDate(page);
    const currentExpireDate = formatChineseDate(currentExpireDateRaw);

    await page.locator('text=更新する').click();
    await setTimeout(3000);
    await page.locator('text=引き続き無料VPSの利用を継続する').click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 验证码处理（最多尝试 maxCaptchaTries 次，自动刷新并截图失败）
    const maxCaptchaTries = 3;
    let solved = false;

    // 进入验证码页面后，先等待Turnstile，如果没有就继续
    let turnstileHandled = false;
    for (let i = 0; i < 5; i++) {
        await setTimeout(1000); // 每秒检查一次
        
        // 首先检查主页面是否有data-sitekey属性的Turnstile元素
        const mainPageTurnstile = await page.$('[data-sitekey*="0x4AAAAAABlb1fIlWBrSDU3B"], [data-sitekey^="0x4"], [data-callback="callbackTurnstile"]');
        if (mainPageTurnstile) {
            console.log('在主页面找到Cloudflare Turnstile元素');
            try {
                await page.click('[data-sitekey*="0x4AAAAAABlb1fIlWBrSDU3B"], [data-sitekey^="0x4"], [data-callback="callbackTurnstile"]');
                console.log('已点击主页面Cloudflare Turnstile元素');
                turnstileHandled = true;
                break;
            } catch (e) {
                console.warn('点击主页面Turnstile元素失败:', e.message);
            }
        }
        
        // 查找Turnstile iframe - 使用更准确的URL匹配
        const turnstileFrame = page.frames().find(
            f => f.url().includes('challenges.cloudflare.com') || 
                 f.url().includes('turnstile') ||
                 f.url().includes('cf-chl-widget')
        );
        
        if (turnstileFrame) {
            console.log(`找到Cloudflare Turnstile iframe: ${turnstileFrame.url()}`);
            
            // 尝试多种选择器策略
            const selectors = [
                '.ctp-checkbox-label',
                '.cf-turnstile-wrapper',
                '[type="checkbox"]',
                '.cb-lb',
                '.ctp-checkbox',
                'input[type="checkbox"]'
            ];
            
            let clicked = false;
            for (const selector of selectors) {
                try {
                    await turnstileFrame.waitForSelector(selector, { timeout: 3000 });
                    await turnstileFrame.click(selector);
                    console.log(`已点击Cloudflare Turnstile人机验证框 (选择器: ${selector})`);
                    clicked = true;
                    turnstileHandled = true;
                    break;
                } catch (e) {
                    console.log(`选择器 ${selector} 未找到或点击失败`);
                }
            }
            
            if (clicked) break;
        }
        
        console.log(`Turnstile检查第 ${i + 1} 次，暂未找到可用元素`);
        
        if (i === 4) {
            console.warn('5秒内未找到或无法点击Cloudflare Turnstile，保存页面以便排查');
            fs.writeFileSync('turnstile_debug.html', await page.content());
            
            // 同时保存所有frame的内容用于调试
            const frames = page.frames();
            for (let j = 0; j < frames.length; j++) {
                try {
                    const frameContent = await frames[j].content();
                    fs.writeFileSync(`turnstile_frame_${j}_debug.html`, frameContent);
                    console.log(`保存frame ${j} 内容: ${frames[j].url()}`);
                } catch (e) {
                    console.warn(`无法获取frame ${j} 内容:`, e.message);
                }
            }
        }
    }
    
    if (turnstileHandled) {
        console.log('Turnstile处理完成，等待验证结果...');
        await setTimeout(2000); // 等待验证处理
    }
    
    for (let attempt = 1; attempt <= maxCaptchaTries; attempt++) {
        const captchaImg = await page.$('img[src^="data:"]');
        if (!captchaImg) {
            console.log('无验证码，跳过验证码填写');
            fs.writeFileSync('no_captcha.html', await page.content());
            solved = true;
            break;
        }
    
        const base64 = await captchaImg.evaluate(img => img.src);
        let code = '';
        try {
            code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
                method: 'POST',
                body: base64,
            }).then(r => r.text());
        } catch (err) {
            console.warn(`验证码识别接口失败 (第 ${attempt} 次):`, err);
            await captchaImg.screenshot({ path: `captcha_failed_${attempt}.png` });
            continue;
        }
    
        if (!code || code.length < 4) {
            console.warn(`验证码识别失败 (第 ${attempt} 次)`);
            await captchaImg.screenshot({ path: `captcha_failed_${attempt}.png` });
            continue;
        }
    
        await page.locator('[placeholder="上の画像的数字を入力"]').fill(code);
        const [nav] = await Promise.allSettled([
            page.waitForNavigation({ timeout: 30000, waitUntil: 'networkidle2' }),
            page.locator('text=無料VPSの利用を継続する').click(),
        ]);
    
        if (nav.status === 'fulfilled') {
            console.log(`验证码尝试成功 (第 ${attempt} 次)`);
            solved = true;
            break;
        }
    
        console.warn(`验证码尝试失败 (第 ${attempt} 次)，刷新重试...`);
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    }
    
    if (!solved) {
        throw new Error('验证码识别失败：尝试多次未成功');
    }
    
    const bodyText = await page.evaluate(() => document.body.innerText);
    const notYetTimeMessage = bodyText.includes('利用期限の1日前から更新手続きが可能です');

    let renewAvailableDate = '';
    if (notYetTimeMessage) {
        const match = bodyText.match(/(\d{4}年\d{1,2}月\d{1,2}日)以降にお試しください/);
        if (match) {
            renewAvailableDate = formatChineseDate(match[1]);
        }
        infoMessage = `🗓️ 未到续费时间\n\n网站提示需要到期前一天才能操作。\n可续期日期: \`${renewAvailableDate || '未知'}\`\n当前到期日: \`${currentExpireDate || '未知'}\`\n\n北京时间: ${getBeijingTimeString()}`;
        console.log(infoMessage);
        // 不立即发送，等待录屏上传后统一通知
    } else {
        console.log('Proceeding with the final renewal step...');
        await page.locator('text=無料VPSの利用を継続する').click()
        await page.waitForNavigation({ waitUntil: 'networkidle2' })
        console.log('Returned to panel after renewal.');

        // 续期后，回到契约信息页面（通过点击菜单）
        await page.goto('https://secure.xserver.ne.jp/xapanel/xvps/index', { waitUntil: 'networkidle2' });
        await page.locator('.contract__menuIcon').click();
        await page.locator('text=契約情報').click();
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        await page.waitForSelector('th', {timeout: 10000});
        await setTimeout(3000); // 稍作等待
        const newExpireDateRaw = await getExpirationDate(page);
        const newExpireDate = formatChineseDate(newExpireDateRaw);

        const nextRenewDate = getNextRenewAvailableDate(newExpireDate);

        if (newExpireDate && newExpireDate !== formatChineseDate(lastExpireDate)) {
            const successMessage = `🎉 VPS 续费成功！

- 新到期日: \`${newExpireDate || '无'}\`
- 下次可续期日期: \`${nextRenewDate}\`

北京时间: ${getBeijingTimeString()}`
            console.log(successMessage)
            infoMessage = successMessage;
            fs.writeFileSync(expireDateFile, newExpireDate)
        } else if (newExpireDate) {
            const failMessage = `⚠️ VPS 续费失败或未执行！\n\n到期日未发生变化，当前仍为: \`${newExpireDate}\`\n请检查录屏或日志确认续期流程是否正常。\n\n北京时间: ${getBeijingTimeString()}`
            console.warn(failMessage)
            infoMessage = failMessage;
        } else {
            throw new Error('无法找到 VPS 到期日。续期后未能定位到期日，脚本可能需要更新。');
        }
    }

} catch (e) {
    console.error('An error occurred during the renewal process:', e)
    scriptErrorMessage = `🚨 **VPS 续期脚本执行出错** 🚨\n\n错误信息: \`${e.message}\`\n\n北京时间: ${getBeijingTimeString()}`
} finally {
    console.log('Script finished. Closing browser and saving recording.')
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()

    let finalNotification = ''
    let webdavMessage = ''
    let turnstileDebugMessage = ''

    // 录屏上传
    if (fs.existsSync(recordingPath)) {
        const timestamp = getBeijingTimeString().replace(/[\s:]/g, '-');
        const remoteFileName = `vps-renewal_${timestamp}.webm`
        webdavMessage = await uploadToWebDAV(recordingPath, remoteFileName)
    }

    // turnstile debug html 上传
    if (fs.existsSync('turnstile_debug.html')) {
        const timestamp = getBeijingTimeString().replace(/[\s:]/g, '-');
        const remoteDebugFileName = `turnstile_debug_${timestamp}.html`;
        turnstileDebugMessage = await uploadToWebDAV('turnstile_debug.html', remoteDebugFileName);
    }

    // 合并最终通知消息
    if (scriptErrorMessage) {
        finalNotification = scriptErrorMessage;
        if (webdavMessage) {
            finalNotification += `\n\n---\n${webdavMessage}`;
        }
        if (turnstileDebugMessage) {
            finalNotification += `\n\n---\n${turnstileDebugMessage}`;
        }
    } else if (infoMessage) {
        finalNotification = infoMessage;
        if (webdavMessage) {
            finalNotification += `\n\n---\n${webdavMessage}`;
        }
        if (turnstileDebugMessage) {
            finalNotification += `\n\n---\n${turnstileDebugMessage}`;
        }
    } else if (webdavMessage || turnstileDebugMessage) {
        finalNotification = webdavMessage;
        if (turnstileDebugMessage) {
            finalNotification += finalNotification ? `\n\n---\n${turnstileDebugMessage}` : turnstileDebugMessage;
        }
    }

    if (finalNotification) {
        await sendTelegramMessage(finalNotification);
    }
}
