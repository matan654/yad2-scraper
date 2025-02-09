const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const config = require('./config.json');
const puppeteer = require('puppeteer');

const getYad2Response = async (url) => {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        const page = await browser.newPage();
        
        // הגדרת User Agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36');
        
        // הגדרת לוקיישן עברית
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'he-IL,he;q=0.9'
        });
        
        await page.goto(url, {waitUntil: 'networkidle0'});
        
        // המתנה לטעינת התוכן
        await page.waitForSelector('.feed_item', {timeout: 10000}).catch(() => {});
        
        const content = await page.content();
        return content;
    } finally {
        await browser.close();
    }
}

const scrapeItemsAndExtractImgUrls = async (url) => {
    const yad2Html = await getYad2Response(url);
    if (!yad2Html) {
        throw new Error("Could not get Yad2 response");
    }
    
    // שמירת ה-HTML לבדיקה
    fs.writeFileSync('last_response.html', yad2Html);
    
    const $ = cheerio.load(yad2Html);
    
    // בדיקת חסימה
    if (yad2Html.includes("מצאתי רכב קטן בייד2") || yad2Html.includes("ShieldSquare Captcha")) {
        throw new Error("Access blocked by Yad2");
    }

    // ניסיון למצוא מודעות עם סלקטורים שונים
    const $feedItems = $('.main-container .feed-item');
    
    if (!$feedItems.length) {
        console.log("Available elements:", $('*').map((_, el) => `${el.tagName}.${$(el).attr('class')}`).get().join('\n'));
        throw new Error("Could not find feed items");
    }

    const imageUrls = [];
    $feedItems.each((_, elm) => {
        const $imgs = $(elm).find('img');
        $imgs.each((__, img) => {
            const src = $(img).attr('src');
            if (src && !src.includes('placeholder')) {
                imageUrls.push(src);
            }
        });
    });

    console.log(`Found ${imageUrls.length} images`);
    return imageUrls;
}

const checkIfHasNewItem = async (imgUrls, topic) => {
    const filePath = `./data/${topic}.json`;
    let savedUrls = [];
    try {
        savedUrls = require(filePath);
    } catch (e) {
        if (e.code === "MODULE_NOT_FOUND") {
            fs.mkdirSync('data', { recursive: true });
            fs.writeFileSync(filePath, '[]');
        } else {
            console.log(e);
            throw new Error(`Could not read / create ${filePath}`);
        }
    }
    let shouldUpdateFile = false;
    savedUrls = savedUrls.filter(savedUrl => {
        shouldUpdateFile = true;
        return imgUrls.includes(savedUrl);
    });
    const newItems = [];
    imgUrls.forEach(url => {
        if (!savedUrls.includes(url)) {
            savedUrls.push(url);
            newItems.push(url);
            shouldUpdateFile = true;
        }
    });
    if (shouldUpdateFile) {
        const updatedUrls = JSON.stringify(savedUrls, null, 2);
        fs.writeFileSync(filePath, updatedUrls);
        await createPushFlagForWorkflow();
    }
    return newItems;
}

const createPushFlagForWorkflow = () => {
    fs.writeFileSync("push_me", "")
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const scrape = async (topic, url, retries = 3) => {
    const apiToken = process.env.API_TOKEN || config.telegramApiToken;
    const chatId = process.env.CHAT_ID || config.chatId;
    const telenode = new Telenode({apiToken})
    
    try {
        await telenode.sendTextMessage(`Starting scanning ${topic} on link:\n${url}`, chatId)
        
        let lastError;
        for (let i = 0; i < retries; i++) {
            try {
                const scrapeImgResults = await scrapeItemsAndExtractImgUrls(url);
                const newItems = await checkIfHasNewItem(scrapeImgResults, topic);
                
                if (newItems.length > 0) {
                    const newItemsJoined = newItems.join("\n----------\n");
                    const msg = `${newItems.length} new items:\n${newItemsJoined}`
                    await telenode.sendTextMessage(msg, chatId);
                } else {
                    await telenode.sendTextMessage("No new items were added", chatId);
                }
                return; // אם הגענו לכאן, הכל עבד בהצלחה
            } catch (e) {
                lastError = e;
                console.log(`Attempt ${i + 1} failed:`, e.message);
                await delay(5000); // המתנה בין ניסיונות
            }
        }
        
        let errMsg = lastError?.message || "";
        if (errMsg) {
            errMsg = `Error: ${errMsg}`;
        }
        await telenode.sendTextMessage(`Scan workflow failed after ${retries} attempts... 😥\n${errMsg}`, chatId);
        throw lastError;
    } catch (e) {
        throw e;
    }
}

const program = async () => {
    for (const project of config.projects.filter(p => !p.disabled)) {
        await scrape(project.topic, project.url);
        await delay(30000); // 30 שניות בין בקשות
    }
};

program();