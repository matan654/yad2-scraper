const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const config = require('./config.json');

const getYad2Response = async (url) => {
    const requestOptions = {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5'
        },
        redirect: 'follow'
    };
    try {
        const res = await fetch(url, requestOptions)
        return await res.text()
    } catch (err) {
        console.log(err)
    }
}

const scrapeItemsAndExtractImgUrls = async (url) => {
    const yad2Html = await getYad2Response(url);
    if (!yad2Html) {
        throw new Error("Could not get Yad2 response");
    }
    const $ = cheerio.load(yad2Html);
    
    if (yad2Html.includes("מצאתי רכב קטן בייד2")) {
        throw new Error("Yad2 blocked access");
    }

    const $feedItems = $("[data-test-id='feed_item']");
    if (!$feedItems.length) {
        console.log("No feed items found");
        throw new Error("Could not find feed items");
    }

    const imageUrls = [];
    $feedItems.each((_, elm) => {
        const imgSrc = $(elm).find("[data-test-id='image_thumb']").attr('src');
        if (imgSrc) {
            imageUrls.push(imgSrc);
        }
    });
    
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
        await delay(10000); // השהייה של 10 שניות בין בקשות
    }
};

program();