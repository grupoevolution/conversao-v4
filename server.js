const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const app = express();

// ============ CONFIGURAÇÕES ============
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://evo.flowzap.fun';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'SUA_API_KEY_AQUI';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const PHRASE_COOLDOWN = 24 * 60 * 60 * 1000; // 24 horas para frases-chave
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'funnels.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'data', 'conversations.json');
const PHRASES_FILE = path.join(__dirname, 'data', 'phrases.json');
const LOGS_FILE = path.join(__dirname, 'data', 'logs.json');
const MANUAL_TRIGGERS_FILE = path.join(__dirname, 'data', 'manual_triggers.json');

// Produtos CS e FB (Kirvano)
const PRODUCT_MAPPING = {
    '5c1f6390-8999-4740-b16f-51380e1097e4': 'CS',
    '0f393085-4960-4c71-9efe-faee8ba51d3f': 'CS',
    'e2282b4c-878c-4bcd-becb-1977dfd6d2b8': 'CS',
    '5288799c-d8e3-48ce-a91d-587814acdee5': 'FB'
};

// Códigos dos planos PerfectPay
const PERFECTPAY_PLANS = {
    'PPLQQMSFI': 'CS',
    'PPLQQMSFH': 'CS',
    'PPLQQM9AP': 'FB'
};

const INSTANCES = [
    'GABY01', 'GABY02', 'GABY03', 'GABY04', 'GABY05', 
    'GABY06', 'GABY07', 'GABY08', 'GABY09', 'GABY10', 
    'GABY11', 'GABY12', 'GABY13', 'GABY14', 'GABY15'
];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let conversations = new Map();
let phoneIndex = new Map();
let stickyInstances = new Map();
let pixTimeouts = new Map();
let webhookLocks = new Map();
let logs = [];
let funis = new Map();
let lastSuccessfulInstanceIndex = -1;
let phraseTriggers = new Map();
let phraseCooldowns = new Map();
let manualTriggers = new Map();

const LOG_LEVELS = {
    DEBUG: 'DEBUG',
    INFO: 'INFO',
    WARNING: 'WARNING',
    ERROR: 'ERROR',
    CRITICAL: 'CRITICAL'
};

// ============ FUNIS PADRÃO ============
const defaultFunnels = {
    'CS_APROVADA': { id: 'CS_APROVADA', name: 'CS - Compra Aprovada', steps: [] },
    'CS_PIX': { id: 'CS_PIX', name: 'CS - PIX Pendente', steps: [] },
    'FB_APROVADA': { id: 'FB_APROVADA', name: 'FB - Compra Aprovada', steps: [] },
    'FB_PIX': { id: 'FB_PIX', name: 'FB - PIX Pendente', steps: [] }
};

// ============ SISTEMA DE LOGS MELHORADO ============
function addLog(type, message, data = null, level = LOG_LEVELS.INFO) {
    const log = {
        id: Date.now() + Math.random(),
        timestamp: new Date().toISOString(),
        type,
        level,
        message,
        data: data ? JSON.stringify(data) : null,
        stack: level === LOG_LEVELS.ERROR || level === LOG_LEVELS.CRITICAL ? new Error().stack : null
    };
    
    logs.unshift(log);
    if (logs.length > 5000) logs = logs.slice(0, 5000);
    
    const emoji = {
        [LOG_LEVELS.DEBUG]: '🔍',
        [LOG_LEVELS.INFO]: 'ℹ️',
        [LOG_LEVELS.WARNING]: '⚠️',
        [LOG_LEVELS.ERROR]: '❌',
        [LOG_LEVELS.CRITICAL]: '🔥'
    };
    
    console.log(`[${log.timestamp}] ${emoji[level] || ''} ${type}: ${message}`);
    if (data) console.log('  Data:', data);
}

async function saveLogsToFile() {
    try {
        await ensureDataDir();
        const recentLogs = logs.slice(0, 1000);
        await fs.writeFile(LOGS_FILE, JSON.stringify(recentLogs, null, 2));
    } catch (error) {
        console.error('Erro ao salvar logs:', error.message);
    }
}

async function loadLogsFromFile() {
    try {
        const data = await fs.readFile(LOGS_FILE, 'utf8');
        logs = JSON.parse(data);
        addLog('LOGS_LOADED', `Logs carregados: ${logs.length}`, null, LOG_LEVELS.INFO);
    } catch (error) {
        addLog('LOGS_LOAD_ERROR', 'Sem logs anteriores', null, LOG_LEVELS.DEBUG);
    }
}

// ============ SISTEMA DE LOCK COM VALIDAÇÕES ============
async function acquireWebhookLock(phoneKey, timeout = 10000) {
    const startTime = Date.now();
    let attempts = 0;
    
    while (webhookLocks.get(phoneKey)) {
        attempts++;
        if (Date.now() - startTime > timeout) {
            addLog('WEBHOOK_LOCK_TIMEOUT', `Timeout após ${attempts} tentativas`, 
                { phoneKey, waitTime: timeout }, LOG_LEVELS.WARNING);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    webhookLocks.set(phoneKey, { 
        acquired: Date.now(), 
        stack: new Error().stack 
    });
    
    addLog('WEBHOOK_LOCK_ACQUIRED', `Lock adquirido (tentativas: ${attempts})`, 
        { phoneKey }, LOG_LEVELS.DEBUG);
    return true;
}

function releaseWebhookLock(phoneKey) {
    const lock = webhookLocks.get(phoneKey);
    webhookLocks.delete(phoneKey);
    
    if (lock) {
        const duration = Date.now() - lock.acquired;
        addLog('WEBHOOK_LOCK_RELEASED', `Lock liberado após ${duration}ms`, 
            { phoneKey, duration }, LOG_LEVELS.DEBUG);
    }
}

// ============ PERSISTÊNCIA DE DADOS ============
async function ensureDataDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    } catch (error) {
        console.log('Pasta data já existe');
    }
}

async function saveFunnelsToFile() {
    try {
        await ensureDataDir();
        const funnelsArray = Array.from(funis.values());
        await fs.writeFile(DATA_FILE, JSON.stringify(funnelsArray, null, 2));
        addLog('DATA_SAVE', `Funis salvos: ${funnelsArray.length}`, null, LOG_LEVELS.DEBUG);
    } catch (error) {
        addLog('DATA_SAVE_ERROR', `Erro: ${error.message}`, null, LOG_LEVELS.ERROR);
    }
}

async function loadFunnelsFromFile() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        const funnelsArray = JSON.parse(data);
        funis.clear();
        funnelsArray.forEach(funnel => {
            if (funnel.id.startsWith('CS_') || funnel.id.startsWith('FB_') || funnel.id.startsWith('PHRASE_')) {
                funis.set(funnel.id, funnel);
            }
        });
        addLog('DATA_LOAD', `Funis carregados: ${funis.size}`, null, LOG_LEVELS.INFO);
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Usando funis padrão', null, LOG_LEVELS.WARNING);
        return false;
    }
}

async function savePhrasesToFile() {
    try {
        await ensureDataDir();
        const phrasesArray = Array.from(phraseTriggers.entries()).map(([phrase, data]) => ({
            phrase,
            funnelId: data.funnelId,
            active: data.active,
            triggerCount: data.triggerCount
        }));
        await fs.writeFile(PHRASES_FILE, JSON.stringify(phrasesArray, null, 2));
        addLog('PHRASES_SAVE', `Frases salvas: ${phrasesArray.length}`, null, LOG_LEVELS.DEBUG);
    } catch (error) {
        addLog('PHRASES_SAVE_ERROR', `Erro: ${error.message}`, null, LOG_LEVELS.ERROR);
    }
}

async function loadPhrasesFromFile() {
    try {
        const data = await fs.readFile(PHRASES_FILE, 'utf8');
        const phrasesArray = JSON.parse(data);
        phraseTriggers.clear();
        phrasesArray.forEach(item => {
            phraseTriggers.set(item.phrase, {
                funnelId: item.funnelId,
                active: item.active !== false,
                triggerCount: item.triggerCount || 0
            });
        });
        addLog('PHRASES_LOAD', `Frases carregadas: ${phraseTriggers.size}`, null, LOG_LEVELS.INFO);
        return true;
    } catch (error) {
        addLog('PHRASES_LOAD_ERROR', 'Nenhuma frase cadastrada', null, LOG_LEVELS.DEBUG);
        return false;
    }
}

async function saveManualTriggersToFile() {
    try {
        await ensureDataDir();
        const triggersArray = Array.from(manualTriggers.entries()).map(([phrase, data]) => ({
            phrase,
            funnelId: data.funnelId,
            active: data.active,
            triggerCount: data.triggerCount
        }));
        await fs.writeFile(MANUAL_TRIGGERS_FILE, JSON.stringify(triggersArray, null, 2));
        addLog('MANUAL_TRIGGERS_SAVE', `Frases manuais salvas: ${triggersArray.length}`, null, LOG_LEVELS.DEBUG);
    } catch (error) {
        addLog('MANUAL_TRIGGERS_SAVE_ERROR', `Erro: ${error.message}`, null, LOG_LEVELS.ERROR);
    }
}

async function loadManualTriggersFromFile() {
    try {
        const data = await fs.readFile(MANUAL_TRIGGERS_FILE, 'utf8');
        const triggersArray = JSON.parse(data);
        manualTriggers.clear();
        triggersArray.forEach(item => {
            manualTriggers.set(item.phrase, {
                funnelId: item.funnelId,
                active: item.active !== false,
                triggerCount: item.triggerCount || 0
            });
        });
        addLog('MANUAL_TRIGGERS_LOAD', `Frases manuais carregadas: ${manualTriggers.size}`, null, LOG_LEVELS.INFO);
        return true;
    } catch (error) {
        addLog('MANUAL_TRIGGERS_LOAD_ERROR', 'Nenhuma frase manual cadastrada', null, LOG_LEVELS.DEBUG);
        return false;
    }
}

async function saveConversationsToFile() {
    try {
        await ensureDataDir();
        const conversationsArray = Array.from(conversations.entries()).map(([key, conv]) => ({
            key,
            ...conv
        }));
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify(conversationsArray, null, 2));
        addLog('CONVERSATIONS_SAVE', `Conversas salvas: ${conversationsArray.length}`, null, LOG_LEVELS.DEBUG);
    } catch (error) {
        addLog('CONVERSATIONS_SAVE_ERROR', `Erro: ${error.message}`, null, LOG_LEVELS.ERROR);
    }
}

async function loadConversationsFromFile() {
    try {
        const data = await fs.readFile(CONVERSATIONS_FILE, 'utf8');
        const conversationsArray = JSON.parse(data);
        conversations.clear();
        phoneIndex.clear();
        stickyInstances.clear();
        
        conversationsArray.forEach(item => {
            const { key, ...conv } = item;
            conversations.set(key, conv);
            phoneIndex.set(conv.remoteJid, key);
            if (conv.stickyInstance) {
                stickyInstances.set(key, conv.stickyInstance);
            }
        });
        
        addLog('CONVERSATIONS_LOAD', `Conversas carregadas: ${conversations.size}`, null, LOG_LEVELS.INFO);
        return true;
    } catch (error) {
        addLog('CONVERSATIONS_LOAD_ERROR', 'Sem conversas anteriores', null, LOG_LEVELS.DEBUG);
        return false;
    }
}

// ============ FUNÇÕES DE ENVIO ============
function getNextInstance() {
    lastSuccessfulInstanceIndex = (lastSuccessfulInstanceIndex + 1) % INSTANCES.length;
    return INSTANCES[lastSuccessfulInstanceIndex];
}

function normalizePhone(phone) {
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('55')) {
        cleaned = cleaned.slice(2);
    }
    return '55' + cleaned;
}

async function sendMessage(phoneNumber, text, instanceName = null) {
    const maxRetries = 3;
    let lastError = null;

    const phoneKey = phoneIndex.get(phoneNumber + '@s.whatsapp.net');
    const useStickyInstance = phoneKey && stickyInstances.has(phoneKey);
    const stickyInstance = useStickyInstance ? stickyInstances.get(phoneKey) : null;

    const instancesToTry = useStickyInstance 
        ? [stickyInstance, ...INSTANCES.filter(i => i !== stickyInstance)]
        : (instanceName ? [instanceName, ...INSTANCES.filter(i => i !== instanceName)] : [...INSTANCES]);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        for (const instance of instancesToTry) {
            try {
                const url = `${EVOLUTION_BASE_URL}/message/sendText/${instance}`;
                const response = await axios.post(url, {
                    number: phoneNumber,
                    text: text,
                    delay: 1200
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': EVOLUTION_API_KEY
                    },
                    timeout: 30000
                });

                if (response.status === 201 && response.data?.key?.id) {
                    addLog('MESSAGE_SENT', `Mensagem enviada - Instância: ${instance}`, 
                        { phone: phoneNumber, instance }, LOG_LEVELS.INFO);
                    
                    if (phoneKey && !stickyInstances.has(phoneKey)) {
                        stickyInstances.set(phoneKey, instance);
                        addLog('STICKY_INSTANCE_SET', `Instância fixa definida: ${instance}`, 
                            { phoneKey, instance }, LOG_LEVELS.DEBUG);
                    }
                    
                    lastSuccessfulInstanceIndex = INSTANCES.indexOf(instance);
                    return { success: true, instance, messageId: response.data.key.id };
                }
            } catch (error) {
                lastError = error;
                addLog('MESSAGE_ERROR', `Erro na instância ${instance} (tentativa ${attempt + 1})`, 
                    { instance, error: error.message, phone: phoneNumber }, LOG_LEVELS.WARNING);
                
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
    }

    addLog('MESSAGE_FAILED', `Falha total após ${maxRetries} tentativas`, 
        { phone: phoneNumber, error: lastError?.message }, LOG_LEVELS.ERROR);
    return { success: false, error: lastError?.message || 'Todas as tentativas falhar am' };
}

async function sendMedia(phoneNumber, mediaUrl, caption = '', mediaType = 'image', instanceName = null) {
    const maxRetries = 3;
    let lastError = null;

    const phoneKey = phoneIndex.get(phoneNumber + '@s.whatsapp.net');
    const useStickyInstance = phoneKey && stickyInstances.has(phoneKey);
    const stickyInstance = useStickyInstance ? stickyInstances.get(phoneKey) : null;

    const instancesToTry = useStickyInstance 
        ? [stickyInstance, ...INSTANCES.filter(i => i !== stickyInstance)]
        : (instanceName ? [instanceName, ...INSTANCES.filter(i => i !== instanceName)] : [...INSTANCES]);

    const endpoint = mediaType === 'video' ? 'sendMedia' : 
                     mediaType === 'audio' ? 'sendWhatsAppAudio' : 'sendMedia';

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        for (const instance of instancesToTry) {
            try {
                const url = `${EVOLUTION_BASE_URL}/message/${endpoint}/${instance}`;
                
                const payload = mediaType === 'audio' 
                    ? { number: phoneNumber, audioUrl: mediaUrl, delay: 1200 }
                    : { number: phoneNumber, mediaUrl: mediaUrl, caption: caption, mediaType: mediaType, delay: 1200 };

                const response = await axios.post(url, payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': EVOLUTION_API_KEY
                    },
                    timeout: 60000
                });

                if (response.status === 201 && response.data?.key?.id) {
                    addLog('MEDIA_SENT', `Mídia enviada - Instância: ${instance}`, 
                        { phone: phoneNumber, type: mediaType, instance }, LOG_LEVELS.INFO);
                    
                    if (phoneKey && !stickyInstances.has(phoneKey)) {
                        stickyInstances.set(phoneKey, instance);
                    }
                    
                    lastSuccessfulInstanceIndex = INSTANCES.indexOf(instance);
                    return { success: true, instance, messageId: response.data.key.id };
                }
            } catch (error) {
                lastError = error;
                addLog('MEDIA_ERROR', `Erro ao enviar mídia na instância ${instance}`, 
                    { instance, error: error.message, phone: phoneNumber, type: mediaType }, LOG_LEVELS.WARNING);
                
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
    }

    addLog('MEDIA_FAILED', `Falha ao enviar mídia após ${maxRetries} tentativas`, 
        { phone: phoneNumber, type: mediaType, error: lastError?.message }, LOG_LEVELS.ERROR);
    return { success: false, error: lastError?.message || 'Todas as tentativas falharam' };
}

async function sendButton(phoneNumber, text, buttons, instanceName = null) {
    const maxRetries = 3;
    let lastError = null;

    const phoneKey = phoneIndex.get(phoneNumber + '@s.whatsapp.net');
    const useStickyInstance = phoneKey && stickyInstances.has(phoneKey);
    const stickyInstance = useStickyInstance ? stickyInstances.get(phoneKey) : null;

    const instancesToTry = useStickyInstance 
        ? [stickyInstance, ...INSTANCES.filter(i => i !== stickyInstance)]
        : (instanceName ? [instanceName, ...INSTANCES.filter(i => i !== instanceName)] : [...INSTANCES]);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        for (const instance of instancesToTry) {
            try {
                const url = `${EVOLUTION_BASE_URL}/message/sendButtons/${instance}`;
                const response = await axios.post(url, {
                    number: phoneNumber,
                    title: text,
                    description: '',
                    footer: '',
                    buttons: buttons
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': EVOLUTION_API_KEY
                    },
                    timeout: 30000
                });

                if (response.status === 201 && response.data?.key?.id) {
                    addLog('BUTTON_SENT', `Botões enviados - Instância: ${instance}`, 
                        { phone: phoneNumber, instance }, LOG_LEVELS.INFO);
                    
                    if (phoneKey && !stickyInstances.has(phoneKey)) {
                        stickyInstances.set(phoneKey, instance);
                    }
                    
                    lastSuccessfulInstanceIndex = INSTANCES.indexOf(instance);
                    return { success: true, instance, messageId: response.data.key.id };
                }
            } catch (error) {
                lastError = error;
                addLog('BUTTON_ERROR', `Erro ao enviar botões na instância ${instance}`, 
                    { instance, error: error.message, phone: phoneNumber }, LOG_LEVELS.WARNING);
                
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
    }

    addLog('BUTTON_FAILED', `Falha ao enviar botões após ${maxRetries} tentativas`, 
        { phone: phoneNumber, error: lastError?.message }, LOG_LEVELS.ERROR);
    return { success: false, error: lastError?.message || 'Todas as tentativas falharam' };
}

async function addToGroup(phoneNumber, groupId, instanceName = null) {
    const maxRetries = 3;
    let lastError = null;

    const phoneKey = phoneIndex.get(phoneNumber + '@s.whatsapp.net');
    const useStickyInstance = phoneKey && stickyInstances.has(phoneKey);
    const stickyInstance = useStickyInstance ? stickyInstances.get(phoneKey) : null;

    const instancesToTry = useStickyInstance 
        ? [stickyInstance, ...INSTANCES.filter(i => i !== stickyInstance)]
        : (instanceName ? [instanceName, ...INSTANCES.filter(i => i !== instanceName)] : [...INSTANCES]);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        for (const instance of instancesToTry) {
            try {
                const url = `${EVOLUTION_BASE_URL}/group/updateParticipant/${instance}`;
                const response = await axios.post(url, {
                    groupId: groupId,
                    action: 'add',
                    participants: [phoneNumber]
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': EVOLUTION_API_KEY
                    },
                    timeout: 30000
                });

                if (response.status === 201 || response.status === 200) {
                    addLog('GROUP_ADD_SUCCESS', `Adicionado ao grupo - Instância: ${instance}`, 
                        { phone: phoneNumber, groupId, instance }, LOG_LEVELS.INFO);
                    
                    if (phoneKey && !stickyInstances.has(phoneKey)) {
                        stickyInstances.set(phoneKey, instance);
                    }
                    
                    lastSuccessfulInstanceIndex = INSTANCES.indexOf(instance);
                    return { success: true, instance };
                }
            } catch (error) {
                lastError = error;
                addLog('GROUP_ADD_ERROR', `Erro ao adicionar no grupo na instância ${instance}`, 
                    { instance, error: error.message, phone: phoneNumber, groupId }, LOG_LEVELS.WARNING);
                
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
    }

    addLog('GROUP_ADD_FAILED', `Falha ao adicionar no grupo após ${maxRetries} tentativas`, 
        { phone: phoneNumber, groupId, error: lastError?.message }, LOG_LEVELS.ERROR);
    return { success: false, error: lastError?.message || 'Todas as tentativas falharam' };
}

// ============ EXECUÇÃO DE FUNIS ============
async function executeFunnel(phoneKey, funnelId, customerData) {
    const funnel = funis.get(funnelId);
    if (!funnel || !funnel.steps || funnel.steps.length === 0) {
        addLog('FUNNEL_ERROR', `Funil não encontrado ou vazio: ${funnelId}`, 
            { funnelId, phoneKey }, LOG_LEVELS.ERROR);
        return;
    }

    const conv = conversations.get(phoneKey) || {};
    const phoneNumber = (conv.remoteJid || customerData.phone || '').replace('@s.whatsapp.net', '');

    if (!phoneNumber) {
        addLog('FUNNEL_ERROR', 'Telefone inválido', { phoneKey, funnelId }, LOG_LEVELS.ERROR);
        return;
    }

    addLog('FUNNEL_START', `Iniciando funil: ${funnel.name}`, 
        { phoneKey, funnelId, steps: funnel.steps.length }, LOG_LEVELS.INFO);

    const conversation = {
        remoteJid: phoneNumber + '@s.whatsapp.net',
        customerName: customerData.name || 'Cliente',
        productType: customerData.productType || 'Desconhecido',
        funnelId: funnelId,
        stepIndex: 0,
        waiting_for_response: false,
        createdAt: new Date().toISOString(),
        lastSystemMessage: null,
        lastReply: null,
        orderCode: customerData.orderCode || null,
        amount: customerData.amount || null,
        pixWaiting: funnelId.includes('PIX'),
        canceled: false,
        completed: false,
        transferredFromPix: customerData.transferredFromPix || false,
        source: customerData.source || 'kirvano'
    };

    conversations.set(phoneKey, conversation);
    phoneIndex.set(conversation.remoteJid, phoneKey);
    await saveConversationsToFile();

    for (let i = 0; i < funnel.steps.length; i++) {
        const step = funnel.steps[i];
        const currentConv = conversations.get(phoneKey);

        if (!currentConv || currentConv.canceled || currentConv.completed) {
            addLog('FUNNEL_INTERRUPTED', 'Funil interrompido', 
                { phoneKey, step: i, reason: !currentConv ? 'removido' : currentConv.canceled ? 'cancelado' : 'completo' }, 
                LOG_LEVELS.WARNING);
            break;
        }

        currentConv.stepIndex = i;
        await saveConversationsToFile();

        if (step.delay && step.delay > 0) {
            addLog('FUNNEL_DELAY', `Aguardando ${step.delay}ms`, 
                { phoneKey, step: i, delay: step.delay }, LOG_LEVELS.DEBUG);
            await new Promise(resolve => setTimeout(resolve, step.delay));
        }

        addLog('FUNNEL_STEP', `Executando passo ${i + 1}/${funnel.steps.length}`, 
            { phoneKey, step: i, type: step.type }, LOG_LEVELS.DEBUG);

        try {
            if (step.type === 'text' && step.content) {
                const processedText = step.content
                    .replace(/{nome}/gi, customerData.name || 'Cliente')
                    .replace(/{codigo}/gi, customerData.orderCode || '')
                    .replace(/{valor}/gi, customerData.amount || '');
                
                await sendMessage(phoneNumber, processedText);
                currentConv.lastSystemMessage = processedText;
            } 
            else if (step.type === 'image' && step.url) {
                await sendMedia(phoneNumber, step.url, step.caption || '', 'image');
            } 
            else if (step.type === 'video' && step.url) {
                await sendMedia(phoneNumber, step.url, step.caption || '', 'video');
            } 
            else if (step.type === 'audio' && step.url) {
                await sendMedia(phoneNumber, step.url, '', 'audio');
            } 
            else if (step.type === 'document' && step.url) {
                await sendMedia(phoneNumber, step.url, step.caption || '', 'document');
            } 
            else if (step.type === 'button' && step.content && step.buttons) {
                await sendButton(phoneNumber, step.content, step.buttons);
            } 
            else if (step.type === 'group' && step.groupId) {
                await addToGroup(phoneNumber, step.groupId);
            }
            else if (step.type === 'wait_reply') {
                currentConv.waiting_for_response = true;
                await saveConversationsToFile();
                addLog('FUNNEL_WAITING', 'Aguardando resposta do cliente', 
                    { phoneKey, step: i }, LOG_LEVELS.INFO);
                return;
            }

            await saveConversationsToFile();

        } catch (error) {
            addLog('FUNNEL_STEP_ERROR', `Erro no passo ${i + 1}`, 
                { phoneKey, step: i, error: error.message }, LOG_LEVELS.ERROR);
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const finalConv = conversations.get(phoneKey);
    if (finalConv && !finalConv.canceled) {
        finalConv.completed = true;
        await saveConversationsToFile();
        addLog('FUNNEL_COMPLETED', `Funil concluído: ${funnel.name}`, 
            { phoneKey, funnelId }, LOG_LEVELS.INFO);
    }
}

// ============ MIDDLEWARE ============
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// ============ WEBHOOK KIRVANO ============
app.post('/webhook/kirvano', async (req, res) => {
    try {
        const data = req.body;
        
        addLog('WEBHOOK_RECEIVED', 'Webhook Kirvano recebido', 
            { 
                event: data.event_type, 
                order: data.order_id,
                customer: data.customer?.name 
            }, 
            LOG_LEVELS.INFO);

        if (!data.customer || !data.customer.phone) {
            addLog('WEBHOOK_ERROR', 'Dados incompletos no webhook', 
                { data }, LOG_LEVELS.ERROR);
            return res.status(400).json({ error: 'Dados incompletos' });
        }

        const phone = normalizePhone(data.customer.phone);
        const phoneKey = uuidv4();
        const productId = data.product?.uuid;
        const productType = PRODUCT_MAPPING[productId];

        if (!productType) {
            addLog('WEBHOOK_IGNORED', 'Produto não mapeado', 
                { productId }, LOG_LEVELS.WARNING);
            return res.json({ success: true, message: 'Produto não configurado' });
        }

        const customerData = {
            phone: phone,
            name: data.customer.name || 'Cliente',
            productType: productType,
            orderCode: data.order_id || '',
            amount: data.order?.amount ? `R$ ${(data.order.amount / 100).toFixed(2)}` : '',
            source: 'kirvano'
        };

        let funnelId = null;

        if (data.event_type === 'order.approved' || data.event_type === 'order.paid') {
            funnelId = `${productType}_APROVADA`;
            
            if (pixTimeouts.has(phone)) {
                clearTimeout(pixTimeouts.get(phone).timeoutId);
                pixTimeouts.delete(phone);
                customerData.transferredFromPix = true;
                addLog('PIX_APPROVED', 'PIX aprovado - convertendo funil', 
                    { phone, productType }, LOG_LEVELS.INFO);
            }
        } 
        else if (data.event_type === 'order.waiting') {
            funnelId = `${productType}_PIX`;
            
            const timeoutId = setTimeout(async () => {
                const lockAcquired = await acquireWebhookLock(phone);
                if (!lockAcquired) return;
                
                try {
                    addLog('PIX_TIMEOUT', 'Timeout do PIX - removendo conversa', 
                        { phone }, LOG_LEVELS.WARNING);
                    
                    const currentPhoneKey = phoneIndex.get(phone + '@s.whatsapp.net');
                    if (currentPhoneKey) {
                        const conv = conversations.get(currentPhoneKey);
                        if (conv) conv.canceled = true;
                        conversations.delete(currentPhoneKey);
                        phoneIndex.delete(phone + '@s.whatsapp.net');
                        stickyInstances.delete(currentPhoneKey);
                    }
                    pixTimeouts.delete(phone);
                    await saveConversationsToFile();
                } finally {
                    releaseWebhookLock(phone);
                }
            }, PIX_TIMEOUT);

            pixTimeouts.set(phone, { timeoutId, productType });
            addLog('PIX_TIMEOUT_SET', `Timeout PIX configurado: ${PIX_TIMEOUT/1000}s`, 
                { phone, productType }, LOG_LEVELS.INFO);
        }

        if (funnelId) {
            const lockAcquired = await acquireWebhookLock(phone);
            if (!lockAcquired) {
                return res.status(429).json({ error: 'Requisição em processamento' });
            }

            try {
                await executeFunnel(phoneKey, funnelId, customerData);
                res.json({ success: true, message: 'Funil iniciado' });
            } finally {
                releaseWebhookLock(phone);
            }
        } else {
            res.json({ success: true, message: 'Evento não processado' });
        }

    } catch (error) {
        addLog('WEBHOOK_ERROR', `Erro crítico: ${error.message}`, 
            { error: error.stack }, LOG_LEVELS.CRITICAL);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// ============ WEBHOOK PERFECTPAY ============
app.post('/webhook/perfect', async (req, res) => {
    try {
        const data = req.body;
        
        addLog('WEBHOOK_RECEIVED', 'Webhook PerfectPay recebido', 
            { 
                status: data.sale_status_enum_key,
                code: data.code,
                plan: data.plan?.code,
                customer: data.customer?.full_name 
            }, 
            LOG_LEVELS.INFO);

        if (!data.customer || !data.customer.phone_number || !data.plan) {
            addLog('WEBHOOK_ERROR', 'Dados incompletos no webhook PerfectPay', 
                { data }, LOG_LEVELS.ERROR);
            return res.status(400).json({ error: 'Dados incompletos' });
        }

        const planCode = data.plan.code;
        const productType = PERFECTPAY_PLANS[planCode];

        if (!productType) {
            addLog('WEBHOOK_IGNORED', 'Plano PerfectPay não mapeado', 
                { planCode }, LOG_LEVELS.WARNING);
            return res.json({ success: true, message: 'Plano não configurado' });
        }

        const phoneArea = data.customer.phone_area_code || '';
        const phoneNum = data.customer.phone_number || '';
        const fullPhone = normalizePhone(phoneArea + phoneNum);
        const phoneKey = uuidv4();

        const customerData = {
            phone: fullPhone,
            name: data.customer.full_name || 'Cliente',
            productType: productType,
            orderCode: data.code || '',
            amount: data.sale_amount ? `R$ ${data.sale_amount.toFixed(2)}` : '',
            source: 'perfectpay'
        };

        let funnelId = null;

        if (data.sale_status_enum_key === 'approved') {
            funnelId = `${productType}_APROVADA`;
            
            if (pixTimeouts.has(fullPhone)) {
                clearTimeout(pixTimeouts.get(fullPhone).timeoutId);
                pixTimeouts.delete(fullPhone);
                customerData.transferredFromPix = true;
                addLog('PIX_APPROVED', 'PIX aprovado (PerfectPay) - convertendo funil', 
                    { phone: fullPhone, productType }, LOG_LEVELS.INFO);
            }
        } 
        else if (data.sale_status_enum_key === 'pending') {
            funnelId = `${productType}_PIX`;
            
            const timeoutId = setTimeout(async () => {
                const lockAcquired = await acquireWebhookLock(fullPhone);
                if (!lockAcquired) return;
                
                try {
                    addLog('PIX_TIMEOUT', 'Timeout do PIX (PerfectPay) - removendo conversa', 
                        { phone: fullPhone }, LOG_LEVELS.WARNING);
                    
                    const currentPhoneKey = phoneIndex.get(fullPhone + '@s.whatsapp.net');
                    if (currentPhoneKey) {
                        const conv = conversations.get(currentPhoneKey);
                        if (conv) conv.canceled = true;
                        conversations.delete(currentPhoneKey);
                        phoneIndex.delete(fullPhone + '@s.whatsapp.net');
                        stickyInstances.delete(currentPhoneKey);
                    }
                    pixTimeouts.delete(fullPhone);
                    await saveConversationsToFile();
                } finally {
                    releaseWebhookLock(fullPhone);
                }
            }, PIX_TIMEOUT);

            pixTimeouts.set(fullPhone, { timeoutId, productType });
            addLog('PIX_TIMEOUT_SET', `Timeout PIX (PerfectPay) configurado: ${PIX_TIMEOUT/1000}s`, 
                { phone: fullPhone, productType }, LOG_LEVELS.INFO);
        }

        if (funnelId) {
            const lockAcquired = await acquireWebhookLock(fullPhone);
            if (!lockAcquired) {
                return res.status(429).json({ error: 'Requisição em processamento' });
            }

            try {
                await executeFunnel(phoneKey, funnelId, customerData);
                res.json({ success: true, message: 'Funil iniciado (PerfectPay)' });
            } finally {
                releaseWebhookLock(fullPhone);
            }
        } else {
            res.json({ success: true, message: 'Evento PerfectPay não processado' });
        }

    } catch (error) {
        addLog('WEBHOOK_ERROR', `Erro crítico (PerfectPay): ${error.message}`, 
            { error: error.stack }, LOG_LEVELS.CRITICAL);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// ============ WEBHOOK EVOLUTION ============
app.post('/webhook/evolution', async (req, res) => {
    try {
        res.status(200).send('OK');
        
        const data = req.body?.data;
        if (!data || data.key?.fromMe) return;

        const messageType = data.messageType;
        const validTypes = ['conversation', 'extendedTextMessage', 'imageMessage', 'audioMessage', 
                           'videoMessage', 'documentMessage', 'buttonsResponseMessage'];
        
        if (!validTypes.includes(messageType)) return;

        const remoteJid = data.key?.remoteJid;
        if (!remoteJid || remoteJid.includes('@g.us')) return;

        addLog('MESSAGE_RECEIVED', 'Mensagem recebida do WhatsApp', 
            { from: remoteJid, type: messageType }, LOG_LEVELS.DEBUG);

        const phoneKey = phoneIndex.get(remoteJid);
        if (!phoneKey) {
            await checkForPhraseTriggers(data, remoteJid);
            return;
        }

        const conv = conversations.get(phoneKey);
        if (!conv) return;

        if (conv.waiting_for_response) {
            let userMessage = '';
            
            if (messageType === 'conversation') {
                userMessage = data.message?.conversation || '';
            } else if (messageType === 'extendedTextMessage') {
                userMessage = data.message?.extendedTextMessage?.text || '';
            } else if (messageType === 'buttonsResponseMessage') {
                userMessage = data.message?.buttonsResponseMessage?.selectedDisplayText || '';
            }

            if (userMessage) {
                conv.lastReply = userMessage;
                conv.waiting_for_response = false;
                await saveConversationsToFile();

                addLog('USER_REPLY', 'Resposta do cliente recebida', 
                    { phoneKey, reply: userMessage }, LOG_LEVELS.INFO);

                const funnel = funis.get(conv.funnelId);
                if (funnel && funnel.steps) {
                    const nextStepIndex = conv.stepIndex + 1;
                    if (nextStepIndex < funnel.steps.length) {
                        conv.stepIndex = nextStepIndex;
                        await saveConversationsToFile();

                        const phoneNumber = remoteJid.replace('@s.whatsapp.net', '');
                        const customerData = {
                            phone: phoneNumber,
                            name: conv.customerName,
                            productType: conv.productType,
                            orderCode: conv.orderCode,
                            amount: conv.amount,
                            source: conv.source
                        };

                        for (let i = nextStepIndex; i < funnel.steps.length; i++) {
                            const step = funnel.steps[i];
                            const currentConv = conversations.get(phoneKey);

                            if (!currentConv || currentConv.canceled || currentConv.completed) break;

                            currentConv.stepIndex = i;
                            await saveConversationsToFile();

                            if (step.delay && step.delay > 0) {
                                await new Promise(resolve => setTimeout(resolve, step.delay));
                            }

                            try {
                                if (step.type === 'text' && step.content) {
                                    const processedText = step.content
                                        .replace(/{nome}/gi, customerData.name)
                                        .replace(/{codigo}/gi, customerData.orderCode)
                                        .replace(/{valor}/gi, customerData.amount);
                                    
                                    await sendMessage(phoneNumber, processedText);
                                    currentConv.lastSystemMessage = processedText;
                                } 
                                else if (step.type === 'image' && step.url) {
                                    await sendMedia(phoneNumber, step.url, step.caption || '', 'image');
                                } 
                                else if (step.type === 'video' && step.url) {
                                    await sendMedia(phoneNumber, step.url, step.caption || '', 'video');
                                } 
                                else if (step.type === 'audio' && step.url) {
                                    await sendMedia(phoneNumber, step.url, '', 'audio');
                                } 
                                else if (step.type === 'document' && step.url) {
                                    await sendMedia(phoneNumber, step.url, step.caption || '', 'document');
                                } 
                                else if (step.type === 'button' && step.content && step.buttons) {
                                    await sendButton(phoneNumber, step.content, step.buttons);
                                } 
                                else if (step.type === 'group' && step.groupId) {
                                    await addToGroup(phoneNumber, step.groupId);
                                }
                                else if (step.type === 'wait_reply') {
                                    currentConv.waiting_for_response = true;
                                    await saveConversationsToFile();
                                    return;
                                }

                                await saveConversationsToFile();

                            } catch (error) {
                                addLog('FUNNEL_STEP_ERROR', `Erro ao continuar funil`, 
                                    { phoneKey, step: i, error: error.message }, LOG_LEVELS.ERROR);
                            }

                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }

                        const finalConv = conversations.get(phoneKey);
                        if (finalConv && !finalConv.canceled) {
                            finalConv.completed = true;
                            await saveConversationsToFile();
                            addLog('FUNNEL_COMPLETED', 'Funil concluído após resposta', 
                                { phoneKey }, LOG_LEVELS.INFO);
                        }
                    }
                }
            }
        }

    } catch (error) {
        addLog('EVOLUTION_WEBHOOK_ERROR', `Erro: ${error.message}`, 
            { error: error.stack }, LOG_LEVELS.ERROR);
    }
});

async function checkForPhraseTriggers(data, remoteJid) {
    try {
        const messageType = data.messageType;
        let userMessage = '';

        if (messageType === 'conversation') {
            userMessage = data.message?.conversation || '';
        } else if (messageType === 'extendedTextMessage') {
            userMessage = data.message?.extendedTextMessage?.text || '';
        }

        if (!userMessage) return;

        const normalizedMessage = userMessage.toLowerCase().trim();
        
        for (const [triggerPhrase, triggerData] of phraseTriggers.entries()) {
            if (!triggerData.active) continue;

            const normalizedTrigger = triggerPhrase.toLowerCase();
            const triggerWords = normalizedTrigger.split(/\s+/);
            
            let foundIndex = -1;
            let allWordsFound = true;
            
            for (const word of triggerWords) {
                const wordIndex = normalizedMessage.indexOf(word, foundIndex + 1);
                if (wordIndex === -1 || (foundIndex !== -1 && wordIndex < foundIndex)) {
                    allWordsFound = false;
                    break;
                }
                foundIndex = wordIndex;
            }

            if (allWordsFound) {
                const cooldownKey = `${remoteJid}_${triggerPhrase}`;
                const lastTrigger = phraseCooldowns.get(cooldownKey);
                
                if (lastTrigger && (Date.now() - lastTrigger < PHRASE_COOLDOWN)) {
                    addLog('PHRASE_COOLDOWN', 'Frase em cooldown', 
                        { phrase: triggerPhrase, remoteJid }, LOG_LEVELS.DEBUG);
                    continue;
                }

                addLog('PHRASE_TRIGGERED', `Frase detectada: "${triggerPhrase}"`, 
                    { phrase: triggerPhrase, funnelId: triggerData.funnelId, remoteJid }, LOG_LEVELS.INFO);

                phraseCooldowns.set(cooldownKey, Date.now());
                triggerData.triggerCount = (triggerData.triggerCount || 0) + 1;
                await savePhrasesToFile();

                const phoneNumber = remoteJid.replace('@s.whatsapp.net', '');
                const phoneKey = uuidv4();

                const customerData = {
                    phone: phoneNumber,
                    name: data.pushName || 'Cliente',
                    productType: 'PHRASE_TRIGGER',
                    orderCode: '',
                    amount: '',
                    source: 'phrase_trigger'
                };

                await executeFunnel(phoneKey, triggerData.funnelId, customerData);
                break;
            }
        }

        for (const [triggerPhrase, triggerData] of manualTriggers.entries()) {
            if (!triggerData.active) continue;

            const normalizedTrigger = triggerPhrase.toLowerCase().trim();
            
            if (normalizedMessage === normalizedTrigger) {
                addLog('MANUAL_TRIGGER_ACTIVATED', `Frase manual detectada: "${triggerPhrase}"`, 
                    { phrase: triggerPhrase, funnelId: triggerData.funnelId, remoteJid }, LOG_LEVELS.INFO);

                triggerData.triggerCount = (triggerData.triggerCount || 0) + 1;
                await saveManualTriggersToFile();

                const phoneNumber = remoteJid.replace('@s.whatsapp.net', '');
                const phoneKey = uuidv4();

                const customerData = {
                    phone: phoneNumber,
                    name: data.pushName || 'Cliente',
                    productType: 'MANUAL_TRIGGER',
                    orderCode: '',
                    amount: '',
                    source: 'manual_trigger'
                };

                await executeFunnel(phoneKey, triggerData.funnelId, customerData);
                break;
            }
        }

    } catch (error) {
        addLog('PHRASE_CHECK_ERROR', `Erro ao verificar frases: ${error.message}`, 
            { error: error.stack }, LOG_LEVELS.ERROR);
    }
}

// ============ ROTAS DA API ============
app.get('/api/stats', (req, res) => {
    const activeConversations = Array.from(conversations.values()).filter(c => !c.completed && !c.canceled).length;
    const completedConversations = Array.from(conversations.values()).filter(c => c.completed).length;
    const canceledConversations = Array.from(conversations.values()).filter(c => c.canceled).length;
    const pixWaiting = Array.from(conversations.values()).filter(c => c.pixWaiting && !c.completed && !c.canceled).length;

    res.json({
        success: true,
        stats: {
            totalConversations: conversations.size,
            activeConversations,
            completedConversations,
            canceledConversations,
            pixWaiting,
            activeLocks: webhookLocks.size,
            stickyInstances: stickyInstances.size,
            totalFunnels: funis.size,
            totalPhrases: phraseTriggers.size,
            totalManualTriggers: manualTriggers.size,
            recentLogs: logs.length
        }
    });
});

app.get('/api/logs', (req, res) => {
    const { level, type, limit = 100 } = req.query;
    let filtered = [...logs];

    if (level) {
        filtered = filtered.filter(log => log.level === level);
    }
    if (type) {
        filtered = filtered.filter(log => log.type.includes(type));
    }

    filtered = filtered.slice(0, parseInt(limit));

    res.json({
        success: true,
        total: logs.length,
        filtered: filtered.length,
        logs: filtered
    });
});

app.delete('/api/logs', (req, res) => {
    logs = [];
    saveLogsToFile();
    addLog('LOGS_CLEARED', 'Logs limpos manualmente', null, LOG_LEVELS.INFO);
    res.json({ success: true, message: 'Logs limpos com sucesso' });
});

app.get('/api/funnels', (req, res) => {
    const funnelsList = Array.from(funis.values());
    res.json({ success: true, data: funnelsList });
});

app.post('/api/funnels', (req, res) => {
    const { id, name, steps } = req.body;
    
    if (!id || !name) {
        return res.status(400).json({ success: false, error: 'ID e nome são obrigatórios' });
    }

    const funnel = {
        id,
        name,
        steps: steps || []
    };

    funis.set(id, funnel);
    saveFunnelsToFile();
    addLog('FUNNEL_CREATED', `Funil criado: ${name}`, { id, stepsCount: steps?.length || 0 }, LOG_LEVELS.INFO);

    res.json({ success: true, message: 'Funil criado com sucesso', funnel });
});

app.put('/api/funnels/:id', (req, res) => {
    const { id } = req.params;
    const { name, steps } = req.body;

    if (!funis.has(id)) {
        return res.status(404).json({ success: false, error: 'Funil não encontrado' });
    }

    const funnel = funis.get(id);
    if (name) funnel.name = name;
    if (steps) funnel.steps = steps;

    funis.set(id, funnel);
    saveFunnelsToFile();
    addLog('FUNNEL_UPDATED', `Funil atualizado: ${id}`, null, LOG_LEVELS.INFO);

    res.json({ success: true, message: 'Funil atualizado com sucesso', funnel });
});

app.delete('/api/funnels/:id', (req, res) => {
    const { id } = req.params;

    if (!funis.has(id)) {
        return res.status(404).json({ success: false, error: 'Funil não encontrado' });
    }

    funis.delete(id);
    saveFunnelsToFile();
    addLog('FUNNEL_DELETED', `Funil excluído: ${id}`, null, LOG_LEVELS.INFO);

    res.json({ success: true, message: 'Funil excluído com sucesso' });
});

app.get('/api/phrases', (req, res) => {
    const phrasesList = Array.from(phraseTriggers.entries()).map(([phrase, data]) => ({
        phrase,
        funnelId: data.funnelId,
        active: data.active !== false,
        triggerCount: data.triggerCount || 0
    }));
    res.json({ success: true, data: phrasesList });
});

app.post('/api/phrases', (req, res) => {
    const { phrase, funnelId } = req.body;
    
    if (!phrase || !funnelId) {
        return res.status(400).json({ success: false, error: 'Frase e funil são obrigatórios' });
    }
    
    const normalizedPhrase = phrase.trim();
    
    if (phraseTriggers.has(normalizedPhrase)) {
        return res.status(400).json({ success: false, error: 'Frase já cadastrada' });
    }
    
    if (!funis.has(funnelId)) {
        return res.status(400).json({ success: false, error: 'Funil não encontrado' });
    }
    
    phraseTriggers.set(normalizedPhrase, {
        funnelId,
        active: true,
        triggerCount: 0
    });
    
    addLog('PHRASE_ADDED', `Frase-chave cadastrada: "${normalizedPhrase}"`, 
        { funnelId }, LOG_LEVELS.INFO);
    savePhrasesToFile();
    
    res.json({ success: true, message: 'Frase-chave cadastrada com sucesso' });
});

app.put('/api/phrases/:phrase', (req, res) => {
    const phrase = decodeURIComponent(req.params.phrase);
    const { funnelId, active } = req.body;
    
    if (!phraseTriggers.has(phrase)) {
        return res.status(404).json({ success: false, error: 'Frase não encontrada' });
    }
    
    const data = phraseTriggers.get(phrase);
    
    if (funnelId !== undefined) {
        if (!funis.has(funnelId)) {
            return res.status(400).json({ success: false, error: 'Funil não encontrado' });
        }
        data.funnelId = funnelId;
    }
    
    if (active !== undefined) {
        data.active = active;
    }
    
    phraseTriggers.set(phrase, data);
    addLog('PHRASE_UPDATED', `Frase-chave atualizada: "${phrase}"`, null, LOG_LEVELS.INFO);
    savePhrasesToFile();
    
    res.json({ success: true, message: 'Frase-chave atualizada com sucesso' });
});

app.delete('/api/phrases/:phrase', (req, res) => {
    const phrase = decodeURIComponent(req.params.phrase);
    
    if (phraseTriggers.has(phrase)) {
        phraseTriggers.delete(phrase);
        addLog('PHRASE_DELETED', `Frase-chave excluída: "${phrase}"`, null, LOG_LEVELS.INFO);
        savePhrasesToFile();
        res.json({ success: true, message: 'Frase excluída com sucesso' });
    } else {
        res.status(404).json({ success: false, error: 'Frase não encontrada' });
    }
});

app.get('/api/manual-triggers', (req, res) => {
    const triggersList = Array.from(manualTriggers.entries()).map(([phrase, data]) => ({
        phrase,
        funnelId: data.funnelId,
        active: data.active !== false,
        triggerCount: data.triggerCount || 0
    }));
    res.json({ success: true, data: triggersList });
});

app.post('/api/manual-triggers', (req, res) => {
    const { phrase, funnelId } = req.body;
    
    if (!phrase || !funnelId) {
        return res.status(400).json({ success: false, error: 'Frase e funil são obrigatórios' });
    }
    
    const normalizedPhrase = phrase.trim();
    
    if (manualTriggers.has(normalizedPhrase)) {
        return res.status(400).json({ success: false, error: 'Frase já cadastrada' });
    }
    
    if (!funis.has(funnelId)) {
        return res.status(400).json({ success: false, error: 'Funil não encontrado' });
    }
    
    manualTriggers.set(normalizedPhrase, {
        funnelId,
        active: true,
        triggerCount: 0
    });
    
    addLog('MANUAL_TRIGGER_ADDED', `Frase manual cadastrada: "${normalizedPhrase}"`, 
        { funnelId }, LOG_LEVELS.INFO);
    saveManualTriggersToFile();
    
    res.json({ success: true, message: 'Frase de disparo manual cadastrada com sucesso' });
});

app.put('/api/manual-triggers/:phrase', (req, res) => {
    const phrase = decodeURIComponent(req.params.phrase);
    const { funnelId, active } = req.body;
    
    if (!manualTriggers.has(phrase)) {
        return res.status(404).json({ success: false, error: 'Frase não encontrada' });
    }
    
    const data = manualTriggers.get(phrase);
    
    if (funnelId !== undefined) {
        if (!funis.has(funnelId)) {
            return res.status(400).json({ success: false, error: 'Funil não encontrado' });
        }
        data.funnelId = funnelId;
    }
    
    if (active !== undefined) {
        data.active = active;
    }
    
    manualTriggers.set(phrase, data);
    addLog('MANUAL_TRIGGER_UPDATED', `Frase manual atualizada: "${phrase}"`, null, LOG_LEVELS.INFO);
    saveManualTriggersToFile();
    
    res.json({ success: true, message: 'Frase de disparo manual atualizada com sucesso' });
});

app.delete('/api/manual-triggers/:phrase', (req, res) => {
    const phrase = decodeURIComponent(req.params.phrase);
    
    if (manualTriggers.has(phrase)) {
        manualTriggers.delete(phrase);
        addLog('MANUAL_TRIGGER_DELETED', `Frase manual excluída: "${phrase}"`, null, LOG_LEVELS.INFO);
        saveManualTriggersToFile();
        res.json({ success: true, message: 'Frase de disparo manual excluída com sucesso' });
    } else {
        res.status(404).json({ success: false, error: 'Frase não encontrada' });
    }
});

app.get('/api/conversations', (req, res) => {
    const conversationsList = Array.from(conversations.entries()).map(([phoneKey, conv]) => ({
        id: phoneKey,
        phone: conv.remoteJid.replace('@s.whatsapp.net', ''),
        phoneKey: phoneKey,
        customerName: conv.customerName,
        productType: conv.productType,
        funnelId: conv.funnelId,
        stepIndex: conv.stepIndex,
        waiting_for_response: conv.waiting_for_response,
        pixWaiting: conv.pixWaiting || false,
        createdAt: conv.createdAt,
        lastSystemMessage: conv.lastSystemMessage,
        lastReply: conv.lastReply,
        orderCode: conv.orderCode,
        amount: conv.amount,
        stickyInstance: stickyInstances.get(phoneKey),
        canceled: conv.canceled || false,
        completed: conv.completed || false,
        hasError: conv.hasError || false,
        errorMessage: conv.errorMessage,
        transferredFromPix: conv.transferredFromPix || false,
        source: conv.source || 'kirvano'
    }));
    
    conversationsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ success: true, data: conversationsList });
});

app.get('/api/debug/evolution', async (req, res) => {
    const debugInfo = {
        evolution_base_url: EVOLUTION_BASE_URL,
        evolution_api_key_configured: EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI',
        evolution_api_key_length: EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI' ? EVOLUTION_API_KEY.length : 0,
        instances: INSTANCES,
        active_conversations: conversations.size,
        sticky_instances_count: stickyInstances.size,
        pix_timeouts_active: pixTimeouts.size,
        webhook_locks_active: webhookLocks.size,
        phrase_triggers_count: phraseTriggers.size,
        manual_triggers_count: manualTriggers.size,
        total_logs: logs.length,
        test_results: []
    };
    
    try {
        const testInstance = INSTANCES[0];
        const url = EVOLUTION_BASE_URL + '/message/sendText/' + testInstance;
        
        const response = await axios.post(url, {
            number: '5511999999999',
            text: 'teste'
        }, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 10000,
            validateStatus: () => true
        });
        
        debugInfo.test_results.push({
            instance: testInstance,
            url: url,
            status: response.status,
            response: response.data
        });
    } catch (error) {
        debugInfo.test_results.push({
            instance: INSTANCES[0],
            error: error.message,
            code: error.code
        });
    }
    
    res.json(debugInfo);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/teste.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'teste.html'));
});

app.get('/logs.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'logs.html'));
});

async function initializeData() {
    console.log('🔄 Carregando dados...');
    await loadFunnelsFromFile();
    await loadConversationsFromFile();
    await loadPhrasesFromFile();
    await loadManualTriggersFromFile();
    await loadLogsFromFile();
    console.log('✅ Inicialização concluída');
    console.log('📊 Funis:', funis.size);
    console.log('💬 Conversas:', conversations.size);
    console.log('🔑 Frases:', phraseTriggers.size);
    console.log('🎯 Frases Manuais:', manualTriggers.size);
    console.log('📋 Logs:', logs.length);
}

app.listen(PORT, async () => {
    console.log('='.repeat(70));
    console.log('🚀 KIRVANO + PERFECTPAY SYSTEM V5.4 - SISTEMA COMPLETO DE FUNIS');
    console.log('='.repeat(70));
    console.log('Porta:', PORT);
    console.log('Evolution:', EVOLUTION_BASE_URL);
    console.log('Instâncias:', INSTANCES.length);
    console.log('');
    console.log('✅ NOVIDADES V5.4:');
    console.log('  1. 🆕 WEBHOOK PERFECTPAY INTEGRADO');
    console.log('  2. ✅ Suporte para Kirvano e PerfectPay simultaneamente');
    console.log('  3. ✅ Mesmo funil para ambas plataformas');
    console.log('  4. ✅ Detecção por código do plano (PerfectPay)');
    console.log('  5. ✅ Conversão automática PIX→Aprovado em ambas');
    console.log('');
    console.log('📡 Endpoints:');
    console.log('  POST /webhook/kirvano           - Eventos Kirvano');
    console.log('  POST /webhook/perfect           - Eventos PerfectPay');
    console.log('  POST /webhook/evolution         - Mensagens WhatsApp');
    console.log('');
    console.log('🎯 Produtos Configurados:');
    console.log('  CS: PPLQQMSFI, PPLQQMSFH (PerfectPay)');
    console.log('  FB: PPLQQM9AP (PerfectPay)');
    console.log('');
    console.log('🌐 Frontend:');
    console.log('  http://localhost:' + PORT + '           - Dashboard principal');
    console.log('  http://localhost:' + PORT + '/logs.html - Sistema de logs');
    console.log('  http://localhost:' + PORT + '/teste.html - Simulador de testes');
    console.log('='.repeat(70));
    
    await initializeData();
});
