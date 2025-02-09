const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const config = require('./config.json');

const getYad2Response = async (url) => {
    const requestOptions = {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'Referer': 'https://www.yad2.co.il/',
            'Cookie': 'y2018-2-cohort=70; abTestKey=42; y2_cohort_2020=31; favorites_userid=hgi941668629796944; __gads=ID=28e49f3721f4b08b:T=1668629797:S=ALNI_MaI0jZ2CppvX9ROZOUiN_dHbKT0Jw; __gpi=UID=00000b7a5326d5c0:T=1668629797:RT=1668629797:S=ALNI_MbyFmFejLNu4LGSpsMj6M-B8bfuSg; fitracking_12=no; previewVersion=new; server_env=production; __unam=57d8850-1858ecc80b9-68b59c1b-5; UTGv2=h4fd432d81456ad174a7c1672ecadb1b348; styleVersion=new; y2_cohort_59=66; canary=never; saved_searches=null; ads=true; adOtr=Tb73b5b1AV'
        },
        redirect: 'follow'
    };
    try {
        const res = await fetch(url, requestOptions);
        return await res.text();
    } catch (err) {
        console.log(err);
        return null;
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