// 简易 CSV 解析器（支持引号内的逗号）
function parseCSV(text) {
    const lines = text.split('\n').filter(line => line.trim());
    if (lines.length === 0) return [];
    
    // 解析表头
    const headers = parseCSVLine(lines[0]);
    
    // 解析数据行
    const data = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length < headers.length - 1) continue; // 允许最后一列为空
        
        const row = {};
        headers.forEach((header, index) => {
            row[header] = values[index] ? values[index].trim() : '';
        });
        data.push(row);
    }
    
    return data;
}

// 解析单行CSV，正确处理引号
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    
    // 添加最后一个字段
    result.push(current.trim());
    
    return result;
}

// 1. 初始化核心語音與狀態變數
const synth = window.speechSynthesis;
// 定義每個 Intent 需要問幾題 (預設是 1 題)
const INTENT_LIMITS = {
    "Chat": 4,      // 關於chat的問題抽 4 題
    "takeoath": 3,     // takeoath 問 3 題
    "takeoath_F": 1,   // takeoath_F 問 1 題（追問）
    "adressA_F" : 3,
    "adressB_F" : 2,
    "MarriageA_F" :3,
    "employmentB_F" :5,
    "employmentC_F" :2,
    "travelA" :4,
    "Lasttrip" :3,
    "Noquestion" :10,
    "yesquestion" :7,

    // 沒有定義的 Intent 預設就是 1 題
};

// 定義哪些 Intent 需要按順序問完所有題目（而不是隨機抽取）
const SEQUENTIAL_INTENTS = [
    "takeoath",        // stage 6 的宣誓問題按順序問
    // 可以添加更多需要順序問的 Intent
];


// 定義哪些追問題應該作為獨立 Intent（不自動觸發，而是按照 INTENT_LIMITS 控制）
const INDEPENDENT_FOLLOWUPS = [
    "takeoath_F",  "adressA_F"  ,"adressB_F" , "MarriageA_F","employmentB_F","employmentC_F" , // takeoath 的追問獨立處理
    // 可以添加更多需要獨立處理的追問 Intent
];

let intentUsageCounter = {};// 紀錄每個 Intent 已經問了幾題
let intentSequenceIndex = {}; // 紀錄順序 Intent 當前問到第幾題
let interviewTree = {};    // 結構化題庫
let followUpQueue = [];    // 追問隊列
let currentStage = 0;      // 當前面試階段 (cat)
let isSessionStarted = false;
let isRevealed = false;
let audioTimeout = null;
let sessionHistoryCount = 0; // 紀錄已問過幾題

// 定義階段組順序 (使用字符串以匹配CSV中的Stage值)
const STAGE_GROUPS = [
    ["0"],           // 單獨：0
    ["1","2","3","4","5"],   // 亂序：1-5
    ["6"],           // 單獨：6
    ["7","8"],         // 亂序：7-8
    ["9"],           // 單獨：9
    ["10"],          // 單獨：10
    ["11","12","13"],    // 亂序：11-13
    ["14","15","16","17"], // 亂序：14-17
    ["18"],          // 單獨：18
    ["19","20","21","22","23","24","25","26","27","28"], // 亂序：19-28
    ["29"],          // 單獨：29
    ["30"],["31"],["32"],["33"],["34"],["35"],["36"],["37"],["38"],["39"],["40"],["41"],["42"]
];

let currentGroupIndex = 0;     // 當前在第幾組
let currentGroupStages = [];   // 當前組內剩餘的階段
let completedStagesCount = 0;  // 已完成的階段數

// 2. 獲取 DOM 元素
const mainBtn = document.getElementById('main-btn');
const qText = document.getElementById('q-text');
const qHidden = document.getElementById('q-hidden');
const qCounter = document.getElementById('q-current');
const qTotal = document.getElementById('q-total');
const audioAnim = document.getElementById('audio-anim');
const practiceScreen = document.getElementById('practice-screen');


// --- 3. 資料處理 (使用 fetch 直接加载) ---

async function Data() {
    try {
        console.log('开始加载 CSV 文件...');
        const response = await fetch('n400_new.csv');
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const csvText = await response.text();
        console.log('CSV 文件加载成功，大小:', csvText.length, '字符');
        
        const data = parseCSV(csvText);
        console.log('解析完成，数据行数:', data.length);
        
        if (data.length === 0) {
            throw new Error('CSV 文件为空或格式不正确');
        }
        
        // 验证数据格式
        const firstRow = data[0];
        if (!firstRow.Content || !firstRow.Stage) {
            throw new Error('CSV 格式不正确，缺少必要的列（Content 或 Stage）');
        }
        
        // 构建题库
        buildInterviewTree(data);
        
        console.log('题库构建完成！阶段数:', Object.keys(interviewTree).length);
        
    } catch (error) {
        console.error('加载 CSV 失败:', error);
        throw new Error(`题库加载失败: ${error.message}`);
    }
}

function buildInterviewTree(data) {
    interviewTree = {};
    
    // 第一遍：建立結構
    data.forEach((row, index) => {
        if (!row.Content || !row.Content.trim()) {
            return;
        }
        
        const stage = row.Stage || "0";
        const intent = row.Intent || "GENERAL";

        if (!interviewTree[stage]) {
            interviewTree[stage] = {};
        }
        
        if (!interviewTree[stage][intent]) {
            interviewTree[stage][intent] = { variants: [], followUps: [] };
        }

        // 如果是獨立追問，加入 variants；否則只有非追問才加入 variants
        if (INDEPENDENT_FOLLOWUPS.includes(intent) || row.IsFollowUp !== "1") {
            interviewTree[stage][intent].variants.push(row);
        }
    });

    // 第二遍：掛載自動觸發的追問（排除獨立追問）
    data.forEach(row => {
        if (row.IsFollowUp === "1" && row.ParentIntent && !INDEPENDENT_FOLLOWUPS.includes(row.Intent)) {
            const parent = row.ParentIntent;
            
            for (let s in interviewTree) {
                if (interviewTree[s][parent]) {
                    interviewTree[s][parent].followUps.push(row);
                }
            }
        }
    });
    
    console.log('题库构建完成！阶段数:', Object.keys(interviewTree).length);
}

// --- 4. 核心邏輯：決定下一題 ---

function getNextStage() {
    // 如果當前組已經用完，進入下一組
    if (currentGroupStages.length === 0) {
        if (currentGroupIndex >= STAGE_GROUPS.length) {
            return null; // 所有階段都完成了
        }
        
        // 獲取下一組階段
        const nextGroup = STAGE_GROUPS[currentGroupIndex];
        currentGroupIndex++;
        
        // 如果組內有多個階段，打亂順序；否則直接使用
        if (nextGroup.length > 1) {
            currentGroupStages = [...nextGroup].sort(() => Math.random() - 0.5);
        } else {
            currentGroupStages = [...nextGroup];
        }
    }
    
    // 從當前組中取出一個階段
    return currentGroupStages.shift();
}

function getNextSmartQuestion() {
    // 優先處理追問
    if (followUpQueue.length > 0) return followUpQueue.shift();

    // 獲取當前階段的數據
    let stageData = interviewTree[currentStage];
    
    // 如果當前階段沒有題目或已用完，切換到下一個階段
    if (!stageData || Object.keys(stageData).length === 0) {
        const nextStage = getNextStage();
        
        if (nextStage === null) {
            // 所有階段都完成了
            return { Content: "Interview complete! You did a great job." };
        }
        
        currentStage = nextStage;
        completedStagesCount++;
        stageData = interviewTree[currentStage];
        
        // 如果新階段也沒有數據，遞歸繼續找
        if (!stageData || Object.keys(stageData).length === 0) {
            return getNextSmartQuestion();
        }
    }

    let intents = Object.keys(stageData);
    let randomIntentKey = intents[Math.floor(Math.random() * intents.length)];
    let intentGroup = stageData[randomIntentKey];
    
    // 如果这个 intent 的 variants 已经用完，删除它并重新选择
    if (!intentGroup.variants || intentGroup.variants.length === 0) {
        delete stageData[randomIntentKey];
        return getNextSmartQuestion(); // 递归重新选择
    }
    
    // --- 核心修改開始 ---
    
    let question;
    const isSequential = SEQUENTIAL_INTENTS.includes(randomIntentKey);
    
    if (isSequential) {
        // 順序模式：按順序選擇題目
        if (!intentSequenceIndex[randomIntentKey]) {
            intentSequenceIndex[randomIntentKey] = 0;
        }
        
        const index = intentSequenceIndex[randomIntentKey];
        if (index < intentGroup.variants.length) {
            question = intentGroup.variants[index];
            intentSequenceIndex[randomIntentKey]++;
        } else {
            // 已經問完所有題目
            question = intentGroup.variants[intentGroup.variants.length - 1];
        }
    } else {
        // 隨機模式：隨機選擇題目
        question = intentGroup.variants[Math.floor(Math.random() * intentGroup.variants.length)];
    }

    // 初始化該 Intent 的計數器
    if (!intentUsageCounter[randomIntentKey]) intentUsageCounter[randomIntentKey] = 0;
    intentUsageCounter[randomIntentKey]++;

    // 取得該 Intent 設定的上限，沒設定則默認為 1
    const limit = INTENT_LIMITS[randomIntentKey] || 1;

    // 如果達到上限，刪除這個 Intent
    if (intentUsageCounter[randomIntentKey] >= limit) {
        delete stageData[randomIntentKey];
        // 重置順序索引
        if (isSequential) {
            delete intentSequenceIndex[randomIntentKey];
        }
    } else if (!isSequential) {
        // 非順序模式：移除已經用過的題目，避免重複
        const index = intentGroup.variants.indexOf(question);
        if (index > -1) intentGroup.variants.splice(index, 1);
    }
    // 順序模式不需要移除，因為我們用索引控制
    
    // --- 核心修改結束 ---

    if (intentGroup.followUps && intentGroup.followUps.length > 0 && Math.random() < 0.7) {
        followUpQueue = [...intentGroup.followUps];
    }

    return question;
}

// --- 5. 語音功能 ---

function getBestVoice() {
    const voices = synth.getVoices();
    return voices.find(v => v.name.includes('Samantha')) || 
           voices.find(v => v.name.includes('Google US English')) ||
           voices.find(v => v.lang.startsWith('en-US')) ||
           voices[0];
}

function playCurrentAudio(text) {
    if (!text) return;
    clearAudio();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = getBestVoice();
    utterance.onstart = () => setAnimation(true);
    utterance.onend = () => setAnimation(false);
    synth.speak(utterance);
}

function clearAudio() {
    synth.cancel();
    if (audioTimeout) clearTimeout(audioTimeout);
    setAnimation(false);
}

function setAnimation(isActive) {
    if (audioAnim) audioAnim.classList.toggle('playing', isActive);
}

function replayAudio() {
    if (qText.innerText) playCurrentAudio(qText.innerText);
}

// --- 6. UI 互動與面試流程 ---

async function handleMainAction() {
    if (!isSessionStarted) {
        await startSession();
    } else {
        nextQuestion();
    }
}

async function startSession() {
    try {
        mainBtn.innerHTML = "載入中...";
        mainBtn.disabled = true;
        
        await Data();
        
        const totalStages = Object.keys(interviewTree).length;
        if (totalStages === 0) {
            throw new Error("题库为空");
        }
        
        console.log(`✅ 题库加载成功，共 ${totalStages} 个阶段`);
        
        isSessionStarted = true;
        
        // 重置所有階段相關變量
        currentGroupIndex = 0;
        currentGroupStages = [];
        completedStagesCount = 0;
        intentUsageCounter = {};
        intentSequenceIndex = {}; // 重置順序索引;
        
        // 手動初始化第一組（stage "0"）
        const firstGroup = STAGE_GROUPS[0];
        currentGroupIndex = 1; // 下次調用 getNextStage() 時會取第2組
        
        if (firstGroup.length > 1) {
            currentGroupStages = [...firstGroup].sort(() => Math.random() - 0.5);
        } else {
            currentGroupStages = [...firstGroup];
        }
        
        currentStage = currentGroupStages.shift(); // 取出第一個階段（應該是"0"）
        
        sessionHistoryCount = 0;
        followUpQueue = [];
        
        mainBtn.innerHTML = "下一題";
        mainBtn.disabled = false;
        
        nextQuestion();
    } catch (error) {
        console.error("启动失败:", error);
        alert(`題庫載入失敗：${error.message}\n\n請確保：\n1. n400_new.csv 與 index.html 在同一目錄\n2. 通過 HTTP 服務器運行（不是直接打開文件）\n\n推荐使用: python -m http.server 8000`);
        mainBtn.innerHTML = "重新載入";
        mainBtn.disabled = false;
    }
}

function nextQuestion() {
    const q = getNextSmartQuestion();
    
    if (q.Content === "Interview complete! You did a great job.") {
        alert(q.Content);
        location.reload();
        return;
    }

    isRevealed = false;
    qHidden.classList.remove('hidden');
    qText.classList.add('hidden');
    
    // 使用 HTML 结构显示英文和中文
    if (q.Translation && q.Translation.trim()) {
        qText.innerHTML = `
            <div class="question-english">${q.Content}</div>
            <div class="question-chinese">${q.Translation}</div>
        `;
    } else {
        qText.innerHTML = `<div class="question-english">${q.Content}</div>`;
    }

    sessionHistoryCount++;
    qCounter.innerText = sessionHistoryCount;
    
    // 計算剩餘進度
    const totalGroups = STAGE_GROUPS.length;
    const remainingGroups = totalGroups - currentGroupIndex + (currentGroupStages.length > 0 ? 1 : 0);
    
    let stageInfo;
    if (remainingGroups > 0) {
        stageInfo = `第 ${currentGroupIndex}/${totalGroups} 組`;
    } else {
        stageInfo = "即將完成";
    }
    
    qTotal.innerText = stageInfo;

    audioTimeout = setTimeout(() => playCurrentAudio(q.Content), 400);
}

function toggleQuestionCard() {
    if (isRevealed) {
        isRevealed = false;
        qHidden.classList.remove('hidden');
        qText.classList.add('hidden');
    } else {
        isRevealed = true;
        qHidden.classList.add('hidden');
        qText.classList.remove('hidden');
    }
}

function restartSession() {
    clearAudio();
    location.reload();
}

function toggleBookmark() {
    console.log("书签功能待实现");
}

// 監聽語音清單加載
window.speechSynthesis.onvoiceschanged = () => {
    synth.getVoices();
};

// 初始化
window.onload = () => {
    console.log("✅ 应用初始化完成！");
    console.log("点击'開始面試'按钮开始");
};