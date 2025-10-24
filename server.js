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
const PHRASE_COOLDOWN = 24 * 60 * 60 * 1000; // 24 horas
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'funnels.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'data', 'conversations.json');
const PHRASES_FILE = path.join(__dirname, 'data', 'phrases.json');
const LOGS_FILE = path.join(__dirname, 'data', 'logs.json');
const MANUAL_TRIGGERS_FILE = path.join(__dirname, 'data', 'manual_triggers.json');
const CAMPAIGNS_FILE = path.join(__dirname, 'data', 'campaigns.json');

// 🚀 CAMPANHAS - Configurações de proteção anti-ban
const CAMPAIGN_CONFIG = {
    DEFAULT_DAILY_LIMIT: 10,           // Padrão: 10 envios/dia por instância
    MIN_INTERVAL: 40 * 60 * 1000,      // 40 minutos
    MAX_INTERVAL: 120 * 60 * 1000,     // 2 horas
    DEFAULT_START_HOUR: 7,             // 7h da manhã
    DEFAULT_END_HOUR: 22,              // 22h da noite
    MAX_CONSECUTIVE_ERRORS: 3,         // Pausa instância após 3 erros seguidos
    TIMEZONE: 'America/Sao_Paulo'      // Horário de Brasília
};

// Produtos CS e FB
const PRODUCT_MAPPING = {
    '5c1f6390-8999-4740-b16f-51380e1097e4': 'CS',
    '0f393085-4960-4c71-9efe-faee8ba51d3f': 'CS',
    'e2282b4c-878c-4bcd-becb-1977dfd6d2b8': 'CS',
    '5288799c-d8e3-48ce-a91d-587814acdee5': 'FB'
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

// 🚀 CAMPANHAS - Armazenamento otimizado
let campaigns = new Map();
let campaignInstances = new Map(); // Estado de cada instância por campanha
let campaignTimers = new Map();    // Timers ativos

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

// ============ MIDDLEWARES ============
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ============ SISTEMA DE LOGS ============
function addLog(type, message, data = null, level = LOG_LEVELS.INFO) {
    const log = {
        id: Date.now() + Math.random(),
        timestamp: new Date().toISOString(),
        type,
        level,
        message,
        data: data ? JSON.stringify(data) : null
    };
    
    logs.unshift(log);
    if (logs.length > 5000) logs = logs.slice(0, 5000);
    
    const emoji = {
        [LOG_LEVELS.DEBUG]: '🔍',
        [LOG_LEVELS.INFO]: 'ℹ️',
        [LOG_LEVELS.WARNING]: '⚠️',
        [LOG_LEVELS.ERROR]: '❌',
        [LOG_LEVELS.CRITICAL]: '🚨'
    };
    
    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${emoji[level]} ${type}: ${message}`);
    if (data && level !== LOG_LEVELS.DEBUG) {
        console.log('  📎 Dados:', data);
    }
}

// ============ FUNÇÕES AUXILIARES ============
function formatPhone(phone) {
    if (!phone) return null;
    phone = phone.replace(/\D/g, '');
    if (phone.startsWith('55') && phone.length === 13) {
        return phone;
    }
    if (phone.length === 11) {
        return '55' + phone;
    }
    return phone;
}

function generateConversationId() {
    return uuidv4();
}

// ============ CARREGAMENTO E SALVAMENTO ============
async function ensureDataDir() {
    const dataDir = path.join(__dirname, 'data');
    try {
        await fs.access(dataDir);
    } catch {
        await fs.mkdir(dataDir, { recursive: true });
        console.log('📁 Pasta data criada');
    }
}

async function loadFunnelsFromFile() {
    try {
        await ensureDataDir();
        const data = await fs.readFile(DATA_FILE, 'utf8');
        const funnelData = JSON.parse(data);
        funis.clear();
        
        Object.values(defaultFunnels).forEach(funnel => {
            funis.set(funnel.id, funnel);
        });
        
        if (Array.isArray(funnelData)) {
            funnelData.forEach(funnel => {
                if (funnel.id) {
                    funis.set(funnel.id, funnel);
                }
            });
        } else if (funnelData && typeof funnelData === 'object') {
            Object.values(funnelData).forEach(funnel => {
                if (funnel.id) {
                    funis.set(funnel.id, funnel);
                }
            });
        }
    } catch (error) {
        console.log('⚠️ Arquivo de funis não encontrado, usando padrão');
        Object.values(defaultFunnels).forEach(funnel => {
            funis.set(funnel.id, funnel);
        });
    }
}

async function loadConversationsFromFile() {
    try {
        await ensureDataDir();
        const data = await fs.readFile(CONVERSATIONS_FILE, 'utf8');
        const convData = JSON.parse(data);
        conversations.clear();
        phoneIndex.clear();
        
        Object.entries(convData).forEach(([id, conv]) => {
            conversations.set(id, conv);
            if (conv.phone) {
                phoneIndex.set(conv.phone, id);
            }
        });
    } catch (error) {
        console.log('⚠️ Arquivo de conversas não encontrado, iniciando vazio');
    }
}

async function loadPhrasesFromFile() {
    try {
        await ensureDataDir();
        const data = await fs.readFile(PHRASES_FILE, 'utf8');
        const phraseData = JSON.parse(data);
        phraseTriggers.clear();
        
        Object.entries(phraseData).forEach(([phrase, trigger]) => {
            phraseTriggers.set(phrase, trigger);
        });
    } catch (error) {
        console.log('⚠️ Arquivo de frases não encontrado, iniciando vazio');
    }
}

async function loadManualTriggersFromFile() {
    try {
        await ensureDataDir();
        const data = await fs.readFile(MANUAL_TRIGGERS_FILE, 'utf8');
        const triggerData = JSON.parse(data);
        manualTriggers.clear();
        
        Object.entries(triggerData).forEach(([id, trigger]) => {
            manualTriggers.set(id, trigger);
        });
    } catch (error) {
        console.log('⚠️ Arquivo de triggers manuais não encontrado, iniciando vazio');
    }
}

async function loadCampaignsFromFile() {
    try {
        await ensureDataDir();
        const data = await fs.readFile(CAMPAIGNS_FILE, 'utf8');
        const campaignData = JSON.parse(data);
        campaigns.clear();
        campaignInstances.clear();
        
        Object.entries(campaignData).forEach(([id, campaign]) => {
            campaigns.set(id, campaign);
            if (campaign.instancesState) {
                campaignInstances.set(id, new Map(Object.entries(campaign.instancesState)));
            }
        });
    } catch (error) {
        console.log('⚠️ Arquivo de campanhas não encontrado, iniciando vazio');
    }
}

async function loadLogsFromFile() {
    try {
        await ensureDataDir();
        const data = await fs.readFile(LOGS_FILE, 'utf8');
        logs = JSON.parse(data);
        if (!Array.isArray(logs)) logs = [];
    } catch (error) {
        console.log('⚠️ Arquivo de logs não encontrado, iniciando vazio');
    }
}

async function saveData() {
    try {
        await ensureDataDir();
        
        const funnelArray = Array.from(funis.values());
        await fs.writeFile(DATA_FILE, JSON.stringify(funnelArray, null, 2));
        
        const convObject = {};
        conversations.forEach((conv, id) => {
            convObject[id] = conv;
        });
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify(convObject, null, 2));
        
        const phraseObject = {};
        phraseTriggers.forEach((trigger, phrase) => {
            phraseObject[phrase] = trigger;
        });
        await fs.writeFile(PHRASES_FILE, JSON.stringify(phraseObject, null, 2));
        
        const manualObject = {};
        manualTriggers.forEach((trigger, id) => {
            manualObject[id] = trigger;
        });
        await fs.writeFile(MANUAL_TRIGGERS_FILE, JSON.stringify(manualObject, null, 2));
        
        const campaignObject = {};
        campaigns.forEach((campaign, id) => {
            const instanceState = campaignInstances.get(id);
            if (instanceState) {
                campaign.instancesState = Object.fromEntries(instanceState.entries());
            }
            campaignObject[id] = campaign;
        });
        await fs.writeFile(CAMPAIGNS_FILE, JSON.stringify(campaignObject, null, 2));
        
        await fs.writeFile(LOGS_FILE, JSON.stringify(logs.slice(0, 5000), null, 2));
    } catch (error) {
        console.error('❌ Erro ao salvar dados:', error);
        addLog('error', 'Erro ao salvar dados', { error: error.message }, LOG_LEVELS.CRITICAL);
    }
}

// ============ FUNÇÕES DO EVOLUTION ============
async function sendMessage(instanceName, phone, text, mediaUrl = null) {
    try {
        const formattedPhone = formatPhone(phone);
        if (!formattedPhone) {
            throw new Error('Telefone inválido');
        }

        let messageData = {
            number: formattedPhone,
            textMessage: { text }
        };

        if (mediaUrl) {
            const extension = mediaUrl.split('.').pop().toLowerCase();
            const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
            const videoExtensions = ['mp4', 'avi', 'mov', 'wmv', 'webm'];
            const audioExtensions = ['mp3', 'wav', 'ogg', 'm4a', 'aac'];
            
            if (imageExtensions.includes(extension)) {
                messageData = {
                    number: formattedPhone,
                    mediaMessage: {
                        mediatype: 'image',
                        media: mediaUrl,
                        caption: text
                    }
                };
            } else if (videoExtensions.includes(extension)) {
                messageData = {
                    number: formattedPhone,
                    mediaMessage: {
                        mediatype: 'video',
                        media: mediaUrl,
                        caption: text
                    }
                };
            } else if (audioExtensions.includes(extension)) {
                messageData = {
                    number: formattedPhone,
                    audioMessage: {
                        audio: mediaUrl
                    }
                };
                if (text) {
                    await sendMessage(instanceName, phone, text);
                }
            }
        }

        const response = await axios.post(
            `${EVOLUTION_BASE_URL}/message/sendText/${instanceName}`,
            messageData,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': EVOLUTION_API_KEY
                }
            }
        );

        return response.data;
    } catch (error) {
        console.error(`❌ Erro ao enviar mensagem para ${phone}:`, error.message);
        throw error;
    }
}

async function sendTypingIndicator(instanceName, phone, duration = 3) {
    try {
        const formattedPhone = formatPhone(phone);
        if (!formattedPhone) return;

        await axios.post(
            `${EVOLUTION_BASE_URL}/chat/sendPresence/${instanceName}`,
            {
                number: formattedPhone,
                delay: duration * 1000,
                presence: 'composing'
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': EVOLUTION_API_KEY
                }
            }
        );
    } catch (error) {
        console.error('⚠️ Erro ao enviar indicador de digitação:', error.message);
    }
}

// ============ PROCESSAMENTO DE FUNIL ============
async function processFunnelStep(instanceName, phone, funnel, stepIndex = 0, conversationId) {
    if (!funnel || !funnel.steps || stepIndex >= funnel.steps.length) {
        addLog('funnel', 'Funil concluído', { 
            funnelId: funnel?.id, 
            phone, 
            totalSteps: funnel?.steps?.length 
        });
        return;
    }

    const step = funnel.steps[stepIndex];
    const conversation = conversations.get(conversationId);
    
    if (!conversation || conversation.status !== 'active') {
        addLog('funnel', 'Conversa não está mais ativa', { conversationId, phone });
        return;
    }

    try {
        if (step.delayBefore && step.delayBefore > 0) {
            await new Promise(resolve => setTimeout(resolve, step.delayBefore * 1000));
        }

        if (step.type === 'delay') {
            const delayMs = (step.delaySeconds || 10) * 1000;
            addLog('funnel', `Aguardando ${step.delaySeconds}s`, { funnelId: funnel.id, phone });
            
            setTimeout(() => {
                processFunnelStep(instanceName, phone, funnel, stepIndex + 1, conversationId);
            }, delayMs);
            return;
        }

        if (step.showTyping) {
            await sendTypingIndicator(instanceName, phone, 3);
        }

        if (step.type === 'text' || step.type === 'image' || step.type === 'video' || step.type === 'audio') {
            await sendMessage(instanceName, phone, step.text, step.mediaUrl);
            
            conversation.messagesCount++;
            conversation.lastMessageAt = new Date().toISOString();
            await saveData();
            
            addLog('message', 'Mensagem enviada', {
                type: step.type,
                phone,
                funnelId: funnel.id,
                stepIndex
            });
        }

        if (step.waitForReply) {
            conversation.waitingForReply = true;
            conversation.currentFunnelStep = stepIndex + 1;
            await saveData();
            addLog('funnel', 'Aguardando resposta do cliente', { phone, funnelId: funnel.id });
        } else {
            setTimeout(() => {
                processFunnelStep(instanceName, phone, funnel, stepIndex + 1, conversationId);
            }, 1000);
        }

    } catch (error) {
        addLog('error', 'Erro ao processar step do funil', {
            error: error.message,
            funnelId: funnel.id,
            stepIndex,
            phone
        }, LOG_LEVELS.ERROR);
        
        conversation.status = 'error';
        conversation.errorMessage = error.message;
        await saveData();
    }
}

// ============ PROCESSAMENTO DE WEBHOOK ============
async function processKirvanoWebhook(eventType, order, productType) {
    const phone = formatPhone(order.customer?.phone);
    
    if (!phone) {
        addLog('webhook', 'Telefone inválido no pedido', { orderId: order.id }, LOG_LEVELS.WARNING);
        return { success: false, error: 'Telefone inválido' };
    }

    const conversationId = phoneIndex.get(phone) || generateConversationId();
    
    if (!conversations.has(conversationId)) {
        conversations.set(conversationId, {
            id: conversationId,
            phone,
            customerName: order.customer?.name || 'Cliente',
            startedAt: new Date().toISOString(),
            status: 'active',
            messagesCount: 0,
            orders: []
        });
        phoneIndex.set(phone, conversationId);
    }

    const conversation = conversations.get(conversationId);
    conversation.orders.push({
        id: order.id,
        type: eventType,
        product: productType,
        timestamp: new Date().toISOString()
    });

    const manualTrigger = Array.from(manualTriggers.values()).find(t => 
        t.eventType === eventType && t.productType === productType && t.active
    );

    if (manualTrigger) {
        const funnel = funis.get(manualTrigger.funnelId);
        if (funnel && funnel.steps && funnel.steps.length > 0) {
            const instanceIndex = (lastSuccessfulInstanceIndex + 1) % INSTANCES.length;
            const selectedInstance = INSTANCES[instanceIndex];
            lastSuccessfulInstanceIndex = instanceIndex;

            stickyInstances.set(phone, selectedInstance);
            
            addLog('webhook', `Trigger manual ativado: ${manualTrigger.name}`, {
                phone,
                eventType,
                productType,
                funnelId: manualTrigger.funnelId,
                instance: selectedInstance
            });

            setTimeout(() => {
                processFunnelStep(selectedInstance, phone, funnel, 0, conversationId);
            }, 1000);

            await saveData();
            return { 
                success: true, 
                funnelId: manualTrigger.funnelId, 
                instance: selectedInstance,
                triggerType: 'manual',
                triggerName: manualTrigger.name
            };
        }
    }

    let funnelId = null;
    if (eventType === 'order_approved') {
        funnelId = productType === 'FB' ? 'FB_APROVADA' : 'CS_APROVADA';
    } else if (eventType === 'order_pending') {
        funnelId = productType === 'FB' ? 'FB_PIX' : 'CS_PIX';
        
        if (pixTimeouts.has(phone)) {
            clearTimeout(pixTimeouts.get(phone));
        }

        const timeout = setTimeout(() => {
            pixTimeouts.delete(phone);
            addLog('pix', 'PIX expirado', { phone }, LOG_LEVELS.WARNING);
        }, PIX_TIMEOUT);

        pixTimeouts.set(phone, timeout);
    } else if (eventType === 'order_cancelled') {
        if (pixTimeouts.has(phone)) {
            clearTimeout(pixTimeouts.get(phone));
            pixTimeouts.delete(phone);
        }
        
        conversation.status = 'cancelled';
        await saveData();
        
        addLog('webhook', 'Pedido cancelado', { phone, orderId: order.id });
        return { success: true, message: 'Pedido cancelado' };
    }

    if (funnelId) {
        const funnel = funis.get(funnelId);
        if (funnel && funnel.steps && funnel.steps.length > 0) {
            const instanceIndex = (lastSuccessfulInstanceIndex + 1) % INSTANCES.length;
            const selectedInstance = INSTANCES[instanceIndex];
            lastSuccessfulInstanceIndex = instanceIndex;

            stickyInstances.set(phone, selectedInstance);
            
            addLog('webhook', `Funil automático: ${funnel.name}`, {
                phone,
                eventType,
                funnelId,
                instance: selectedInstance
            });

            setTimeout(() => {
                processFunnelStep(selectedInstance, phone, funnel, 0, conversationId);
            }, 1000);

            await saveData();
            return { 
                success: true, 
                funnelId, 
                instance: selectedInstance,
                triggerType: 'automatic'
            };
        }
    }

    addLog('webhook', 'Nenhum funil configurado para este evento', {
        eventType,
        productType
    }, LOG_LEVELS.WARNING);

    await saveData();
    return { success: false, error: 'Nenhum funil configurado' };
}

async function processWhatsAppMessage(data) {
    const phone = data.remoteJid?.replace('@s.whatsapp.net', '');
    const message = data.message?.conversation || 
                   data.message?.extendedTextMessage?.text || '';
    
    if (!phone || !message) return;

    const conversationId = phoneIndex.get(phone);
    if (!conversationId) {
        const normalizedMessage = message.toLowerCase().trim();
        const trigger = phraseTriggers.get(normalizedMessage);
        
        if (trigger && trigger.active) {
            const cooldownKey = `${phone}_${normalizedMessage}`;
            const lastUsed = phraseCooldowns.get(cooldownKey);
            
            if (lastUsed && Date.now() - lastUsed < PHRASE_COOLDOWN) {
                const remainingTime = Math.ceil((PHRASE_COOLDOWN - (Date.now() - lastUsed)) / 1000 / 60 / 60);
                addLog('phrase', `Frase em cooldown: ${remainingTime}h restantes`, {
                    phone,
                    phrase: normalizedMessage
                }, LOG_LEVELS.INFO);
                return;
            }
            
            const funnel = funis.get(trigger.funnelId);
            if (funnel && funnel.steps && funnel.steps.length > 0) {
                const newConversationId = generateConversationId();
                const instanceIndex = (lastSuccessfulInstanceIndex + 1) % INSTANCES.length;
                const selectedInstance = INSTANCES[instanceIndex];
                lastSuccessfulInstanceIndex = instanceIndex;
                
                conversations.set(newConversationId, {
                    id: newConversationId,
                    phone,
                    customerName: data.pushName || 'Cliente',
                    startedAt: new Date().toISOString(),
                    status: 'active',
                    messagesCount: 0,
                    triggeredBy: 'phrase',
                    triggerPhrase: normalizedMessage
                });
                
                phoneIndex.set(phone, newConversationId);
                stickyInstances.set(phone, selectedInstance);
                phraseCooldowns.set(cooldownKey, Date.now());
                
                addLog('phrase', `Frase-chave ativada: "${normalizedMessage}"`, {
                    phone,
                    funnelId: trigger.funnelId,
                    instance: selectedInstance
                });
                
                setTimeout(() => {
                    processFunnelStep(selectedInstance, phone, funnel, 0, newConversationId);
                }, 1000);
                
                await saveData();
            }
        }
        
        return;
    }

    const conversation = conversations.get(conversationId);
    if (conversation && conversation.waitingForReply) {
        conversation.waitingForReply = false;
        conversation.lastReply = message;
        conversation.lastReplyAt = new Date().toISOString();
        
        const instance = stickyInstances.get(phone) || INSTANCES[0];
        const funnelId = conversation.currentFunnelId || 
                        conversation.orders?.[conversation.orders.length - 1]?.funnelId;
        
        if (funnelId) {
            const funnel = funis.get(funnelId);
            if (funnel && conversation.currentFunnelStep < funnel.steps.length) {
                addLog('conversation', 'Cliente respondeu, continuando funil', {
                    phone,
                    message: message.substring(0, 50),
                    funnelId,
                    nextStep: conversation.currentFunnelStep
                });
                
                setTimeout(() => {
                    processFunnelStep(instance, phone, funnel, conversation.currentFunnelStep, conversationId);
                }, 1000);
            }
        }
        
        await saveData();
    }
}

// ============ CAMPANHAS ============
function isWithinBusinessHours(startHour, endHour) {
    const now = new Date();
    const hour = now.getHours();
    return hour >= startHour && hour < endHour;
}

function getRandomInterval() {
    return Math.floor(Math.random() * (CAMPAIGN_CONFIG.MAX_INTERVAL - CAMPAIGN_CONFIG.MIN_INTERVAL)) + 
           CAMPAIGN_CONFIG.MIN_INTERVAL;
}

async function sendCampaignMessage(campaign, contact, instanceName) {
    try {
        const funnel = funis.get(campaign.funnelId);
        if (!funnel || !funnel.steps || funnel.steps.length === 0) {
            throw new Error('Funil inválido ou vazio');
        }
        
        const conversationId = generateConversationId();
        conversations.set(conversationId, {
            id: conversationId,
            phone: contact.phone,
            customerName: contact.name || 'Cliente',
            startedAt: new Date().toISOString(),
            status: 'active',
            messagesCount: 0,
            campaignId: campaign.id,
            triggeredBy: 'campaign'
        });
        
        phoneIndex.set(contact.phone, conversationId);
        stickyInstances.set(contact.phone, instanceName);
        
        await processFunnelStep(instanceName, contact.phone, funnel, 0, conversationId);
        
        return { success: true };
    } catch (error) {
        console.error(`Erro ao enviar mensagem de campanha:`, error);
        return { success: false, error: error.message };
    }
}

async function processCampaignQueue(campaignId) {
    const campaign = campaigns.get(campaignId);
    if (!campaign || campaign.status !== 'active') return;
    
    if (!isWithinBusinessHours(campaign.startHour, campaign.endHour)) {
        const nextCheck = 60 * 60 * 1000; // Verifica novamente em 1 hora
        campaignTimers.set(campaignId, setTimeout(() => {
            processCampaignQueue(campaignId);
        }, nextCheck));
        return;
    }
    
    const instances = campaignInstances.get(campaignId);
    if (!instances) return;
    
    let hasMoreContacts = false;
    
    for (const [instanceName, instanceState] of instances) {
        if (instanceState.status !== 'active') continue;
        if (instanceState.dailySent >= campaign.dailyLimit) continue;
        
        const nextIndex = instanceState.lastProcessedIndex + 1;
        if (nextIndex >= instanceState.contacts.length) continue;
        
        hasMoreContacts = true;
        const contact = instanceState.contacts[nextIndex];
        
        const result = await sendCampaignMessage(campaign, contact, instanceName);
        
        if (result.success) {
            instanceState.dailySent++;
            instanceState.lastProcessedIndex = nextIndex;
            instanceState.consecutiveErrors = 0;
            campaign.stats.sent++;
            
            addLog('CAMPAIGN_MESSAGE_SENT', 
                `Mensagem enviada: ${contact.phone}`, 
                { 
                    campaignId, 
                    instanceName, 
                    contactIndex: nextIndex,
                    dailyCount: instanceState.dailySent 
                },
                LOG_LEVELS.INFO
            );
        } else {
            instanceState.consecutiveErrors++;
            campaign.stats.errors++;
            
            if (instanceState.consecutiveErrors >= CAMPAIGN_CONFIG.MAX_CONSECUTIVE_ERRORS) {
                instanceState.status = 'paused';
                instanceState.pausedReason = `Pausada após ${CAMPAIGN_CONFIG.MAX_CONSECUTIVE_ERRORS} erros consecutivos`;
                
                addLog('CAMPAIGN_INSTANCE_PAUSED',
                    `Instância ${instanceName} pausada por erros`,
                    { campaignId, instanceName, errors: instanceState.consecutiveErrors },
                    LOG_LEVELS.WARNING
                );
            }
        }
        
        await saveData();
        break; // Processa apenas um contato por vez
    }
    
    if (!hasMoreContacts) {
        campaign.status = 'completed';
        campaign.completedAt = new Date().toISOString();
        
        addLog('CAMPAIGN_COMPLETED',
            `Campanha concluída: ${campaign.name}`,
            { 
                campaignId,
                totalSent: campaign.stats.sent,
                totalErrors: campaign.stats.errors
            },
            LOG_LEVELS.INFO
        );
        
        await saveData();
        return;
    }
    
    const nextInterval = getRandomInterval();
    campaignTimers.set(campaignId, setTimeout(() => {
        processCampaignQueue(campaignId);
    }, nextInterval));
    
    addLog('CAMPAIGN_NEXT_SCHEDULED',
        `Próximo envio em ${Math.round(nextInterval / 60000)} minutos`,
        { campaignId, nextInterval },
        LOG_LEVELS.DEBUG
    );
}

function startCampaignProcessing(campaignId) {
    const existingTimer = campaignTimers.get(campaignId);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }
    
    const initialDelay = 5000; // 5 segundos para começar
    campaignTimers.set(campaignId, setTimeout(() => {
        processCampaignQueue(campaignId);
    }, initialDelay));
}

function scheduleDailyReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const msUntilMidnight = tomorrow - now;
    
    setTimeout(() => {
        campaignInstances.forEach((instances, campaignId) => {
            instances.forEach((instanceState) => {
                instanceState.dailySent = 0;
            });
        });
        
        addLog('SYSTEM_DAILY_RESET', 'Reset diário de limites de campanha executado', null, LOG_LEVELS.INFO);
        saveData();
        
        scheduleDailyReset();
    }, msUntilMidnight);
}

// ============ ROTAS - WEBHOOKS ============
app.post('/webhook/evolution', async (req, res) => {
    try {
        const { event, instance, data } = req.body;
        
        if (event === 'messages.upsert' && data?.messageType === 'conversation') {
            const webhookId = `${data.remoteJid}_${Date.now()}`;
            
            if (webhookLocks.has(data.remoteJid)) {
                return res.json({ success: true, status: 'duplicate_ignored' });
            }
            
            webhookLocks.set(data.remoteJid, true);
            setTimeout(() => webhookLocks.delete(data.remoteJid), 5000);
            
            await processWhatsAppMessage(data);
            
            return res.json({ success: true, processed: true });
        }
        
        res.json({ success: true, ignored: true });
    } catch (error) {
        console.error('Erro no webhook Evolution:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/webhook/kirvano', async (req, res) => {
    try {
        const webhookData = req.body;
        
        addLog('webhook', 'Webhook recebido', {
            type: webhookData.type,
            hasOrder: !!webhookData.order,
            hasCustomer: !!webhookData.order?.customer
        }, LOG_LEVELS.DEBUG);
        
        let eventType = null;
        if (webhookData.type === 'order_paid' || webhookData.type === 'purchase_approved') {
            eventType = 'order_approved';
        } else if (webhookData.type === 'purchase_pending_payment' || webhookData.type === 'order_pending') {
            eventType = 'order_pending';
        } else if (webhookData.type === 'purchase_cancelled' || webhookData.type === 'order_cancelled') {
            eventType = 'order_cancelled';
        }
        
        if (eventType && webhookData.order) {
            const order = webhookData.order;
            const productIds = order.items?.map(item => item.product_id) || [];
            let productType = 'CS'; // Padrão
            
            for (const productId of productIds) {
                if (PRODUCT_MAPPING[productId]) {
                    productType = PRODUCT_MAPPING[productId];
                    break;
                }
            }
            
            const result = await processKirvanoWebhook(eventType, order, productType);
            
            return res.json({
                success: true,
                processed: result.success,
                details: result
            });
        }
        
        res.json({ 
            success: true, 
            ignored: true,
            reason: 'Event type not handled or missing order data'
        });
        
    } catch (error) {
        console.error('Erro no webhook Kirvano:', error);
        addLog('error', 'Erro no webhook Kirvano', { error: error.message }, LOG_LEVELS.ERROR);
        res.status(500).json({ error: error.message });
    }
});

// ============ ROTAS - API ============
app.get('/api/stats', (req, res) => {
    const stats = {
        totalFunnels: funis.size,
        totalConversations: conversations.size,
        activeConversations: Array.from(conversations.values()).filter(c => c.status === 'active').length,
        totalInstances: INSTANCES.length,
        totalPhrases: phraseTriggers.size,
        activePhrases: Array.from(phraseTriggers.values()).filter(t => t.active).length,
        totalManualTriggers: manualTriggers.size,
        activeManualTriggers: Array.from(manualTriggers.values()).filter(t => t.active).length,
        totalCampaigns: campaigns.size,
        activeCampaigns: Array.from(campaigns.values()).filter(c => c.status === 'active').length
    };
    
    res.json({ success: true, data: stats });
});

app.get('/api/funnels', (req, res) => {
    const funnelList = Array.from(funis.values());
    res.json({ success: true, data: funnelList });
});

app.get('/api/funnels/:id', (req, res) => {
    const funnel = funis.get(req.params.id);
    if (funnel) {
        res.json({ success: true, data: funnel });
    } else {
        res.status(404).json({ success: false, error: 'Funil não encontrado' });
    }
});

app.post('/api/funnels', async (req, res) => {
    try {
        const funnel = req.body;
        if (!funnel.id || !funnel.name) {
            return res.status(400).json({ success: false, error: 'ID e nome são obrigatórios' });
        }
        
        funis.set(funnel.id, funnel);
        await saveData();
        
        addLog('funnel', `Funil criado: ${funnel.name}`, funnel);
        res.json({ success: true, data: funnel });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/funnels/:id', async (req, res) => {
    try {
        const funnelId = req.params.id;
        const updatedFunnel = req.body;
        
        if (!funis.has(funnelId)) {
            return res.status(404).json({ success: false, error: 'Funil não encontrado' });
        }
        
        funis.set(funnelId, { ...updatedFunnel, id: funnelId });
        await saveData();
        
        addLog('funnel', `Funil atualizado: ${updatedFunnel.name}`, updatedFunnel);
        res.json({ success: true, data: updatedFunnel });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// NOVAS ROTAS PARA IMPORTAR/EXPORTAR/DELETAR FUNIS
app.post('/api/funnels/import', async (req, res) => {
    try {
        const { funnels: importedFunnels } = req.body;
        
        if (!importedFunnels || !Array.isArray(importedFunnels)) {
            return res.json({ 
                success: false, 
                error: 'Formato de arquivo inválido' 
            });
        }
        
        let imported = 0;
        let skipped = 0;
        
        for (const funnel of importedFunnels) {
            if (funnel.id && funnel.name) {
                // Valida estrutura do funil
                if (!funnel.steps) funnel.steps = [];
                if (!Array.isArray(funnel.steps)) funnel.steps = [];
                
                funis.set(funnel.id, funnel);
                imported++;
                
                addLog('funnel', `Funil importado: ${funnel.name}`, funnel);
            } else {
                skipped++;
            }
        }
        
        await saveData();
        
        res.json({ 
            success: true, 
            imported,
            skipped,
            message: `${imported} funis importados com sucesso!`
        });
        
    } catch (error) {
        console.error('Erro ao importar funis:', error);
        addLog('error', 'Erro ao importar funis', { error: error.message }, LOG_LEVELS.ERROR);
        res.json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/api/funnels/export', (req, res) => {
    try {
        const exportData = {
            version: '1.0',
            exportDate: new Date().toISOString(),
            funnels: Array.from(funis.values())
        };
        
        res.json({
            success: true,
            data: exportData
        });
        
        addLog('funnel', 'Funis exportados', { count: funis.size });
    } catch (error) {
        console.error('Erro ao exportar funis:', error);
        res.json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.delete('/api/funnels/:id', async (req, res) => {
    try {
        const funnelId = req.params.id;
        
        if (!funis.has(funnelId)) {
            return res.json({ 
                success: false, 
                error: 'Funil não encontrado' 
            });
        }
        
        // Verifica se é um funil padrão
        if (defaultFunnels[funnelId]) {
            return res.json({ 
                success: false, 
                error: 'Não é possível deletar funis padrão do sistema' 
            });
        }
        
        const funnelName = funis.get(funnelId).name;
        funis.delete(funnelId);
        
        // Remove frases associadas
        const phrasesToDelete = [];
        phraseTriggers.forEach((trigger, phrase) => {
            if (trigger.funnelId === funnelId) {
                phrasesToDelete.push(phrase);
            }
        });
        
        phrasesToDelete.forEach(phrase => {
            phraseTriggers.delete(phrase);
        });
        
        // Remove triggers manuais associados
        const triggersToDelete = [];
        manualTriggers.forEach((trigger, id) => {
            if (trigger.funnelId === funnelId) {
                triggersToDelete.push(id);
            }
        });
        
        triggersToDelete.forEach(id => {
            manualTriggers.delete(id);
        });
        
        await saveData();
        
        res.json({ 
            success: true,
            message: `Funil "${funnelName}" deletado com sucesso!`,
            deletedPhrases: phrasesToDelete.length,
            deletedTriggers: triggersToDelete.length
        });
        
        addLog('funnel', `Funil deletado: ${funnelName}`, { 
            funnelId,
            phrasesRemoved: phrasesToDelete.length,
            triggersRemoved: triggersToDelete.length
        });
        
    } catch (error) {
        console.error('Erro ao deletar funil:', error);
        res.json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ============ ROTAS - FRASES ============
app.get('/api/phrases', (req, res) => {
    const phraseList = Array.from(phraseTriggers.entries()).map(([phrase, trigger]) => ({
        phrase,
        ...trigger
    }));
    res.json({ success: true, data: phraseList });
});

app.post('/api/phrases', async (req, res) => {
    try {
        const { phrase, funnelId } = req.body;
        
        if (!phrase || !funnelId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Frase e funil são obrigatórios' 
            });
        }
        
        const normalizedPhrase = phrase.toLowerCase().trim();
        
        phraseTriggers.set(normalizedPhrase, {
            funnelId,
            active: true,
            createdAt: new Date().toISOString()
        });
        
        await saveData();
        
        addLog('phrase', `Frase-chave adicionada: "${normalizedPhrase}"`, { funnelId });
        res.json({ success: true, message: 'Frase-chave adicionada com sucesso' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/phrases/:phrase', async (req, res) => {
    try {
        const phrase = decodeURIComponent(req.params.phrase);
        
        if (phraseTriggers.has(phrase)) {
            phraseTriggers.delete(phrase);
            await saveData();
            
            addLog('phrase', `Frase-chave removida: "${phrase}"`);
            res.json({ success: true, message: 'Frase-chave removida com sucesso' });
        } else {
            res.status(404).json({ success: false, error: 'Frase não encontrada' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ ROTAS - TRIGGERS MANUAIS ============
app.get('/api/manual-triggers', (req, res) => {
    const triggerList = Array.from(manualTriggers.entries()).map(([id, trigger]) => ({
        id,
        ...trigger
    }));
    res.json({ success: true, data: triggerList });
});

app.post('/api/manual-triggers', async (req, res) => {
    try {
        const { eventType, productType, funnelId, name } = req.body;
        
        if (!eventType || !productType || !funnelId || !name) {
            return res.status(400).json({ 
                success: false, 
                error: 'Todos os campos são obrigatórios' 
            });
        }
        
        const id = `trigger_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        manualTriggers.set(id, {
            name,
            eventType,
            productType,
            funnelId,
            active: true,
            createdAt: new Date().toISOString()
        });
        
        await saveData();
        
        addLog('manual_trigger', `Trigger manual criado: ${name}`, { 
            eventType, 
            productType, 
            funnelId 
        });
        
        res.json({ success: true, message: 'Trigger manual criado com sucesso', id });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/manual-triggers/:id', async (req, res) => {
    try {
        const id = req.params.id;
        
        if (manualTriggers.has(id)) {
            const trigger = manualTriggers.get(id);
            manualTriggers.delete(id);
            await saveData();
            
            addLog('manual_trigger', `Trigger manual removido: ${trigger.name}`);
            res.json({ success: true, message: 'Trigger manual removido com sucesso' });
        } else {
            res.status(404).json({ success: false, error: 'Trigger não encontrado' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ ROTAS - CAMPANHAS ============
app.get('/api/campaigns', (req, res) => {
    const campaignList = Array.from(campaigns.entries()).map(([id, campaign]) => {
        const instances = campaignInstances.get(id);
        let totalContacts = 0;
        
        if (instances) {
            instances.forEach(instanceState => {
                totalContacts += instanceState.contacts.length;
            });
        }
        
        return {
            id,
            ...campaign,
            totalContacts,
            funnelName: funis.get(campaign.funnelId)?.name || campaign.funnelId
        };
    });
    
    res.json({ success: true, data: campaignList });
});

app.post('/api/campaigns', async (req, res) => {
    try {
        const { 
            name, 
            funnelId, 
            contacts, 
            dailyLimit = CAMPAIGN_CONFIG.DEFAULT_DAILY_LIMIT,
            startHour = CAMPAIGN_CONFIG.DEFAULT_START_HOUR,
            endHour = CAMPAIGN_CONFIG.DEFAULT_END_HOUR
        } = req.body;
        
        if (!name || !funnelId || !contacts || !Array.isArray(contacts) || contacts.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Nome, funil e contatos são obrigatórios'
            });
        }
        
        const funnel = funis.get(funnelId);
        if (!funnel) {
            return res.status(400).json({
                success: false,
                error: 'Funil não encontrado'
            });
        }
        
        const validContacts = contacts.filter(c => c.phone).map(c => ({
            phone: formatPhone(c.phone),
            name: c.name || 'Cliente'
        }));
        
        if (validContacts.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Nenhum contato válido encontrado'
            });
        }
        
        const campaignId = `campaign_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const instanceStates = new Map();
        const contactsPerInstance = Math.ceil(validContacts.length / INSTANCES.length);
        
        INSTANCES.forEach((instanceName, index) => {
            const start = index * contactsPerInstance;
            const end = Math.min(start + contactsPerInstance, validContacts.length);
            const instanceContacts = validContacts.slice(start, end);
            
            if (instanceContacts.length > 0) {
                instanceStates.set(instanceName, {
                    contacts: instanceContacts,
                    lastProcessedIndex: -1,
                    dailySent: 0,
                    consecutiveErrors: 0,
                    status: 'active'
                });
            }
        });
        
        const campaign = {
            name,
            funnelId,
            dailyLimit,
            startHour,
            endHour,
            status: 'active',
            createdAt: new Date().toISOString(),
            stats: {
                sent: 0,
                errors: 0
            }
        };
        
        campaigns.set(campaignId, campaign);
        campaignInstances.set(campaignId, instanceStates);
        
        await saveData();
        
        addLog('CAMPAIGN_CREATED', `Campanha criada: ${name}`, {
            campaignId,
            totalContacts: validContacts.length,
            instances: instanceStates.size,
            dailyLimit
        }, LOG_LEVELS.INFO);
        
        startCampaignProcessing(campaignId);
        
        res.json({
            success: true,
            message: 'Campanha criada com sucesso',
            campaignId,
            totalContacts: validContacts.length,
            instancesUsed: instanceStates.size
        });
        
    } catch (error) {
        console.error('Erro ao criar campanha:', error);
        addLog('CAMPAIGN_CREATE_ERROR', 'Erro ao criar campanha', 
            { error: error.message }, LOG_LEVELS.ERROR);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/campaigns/:id/pause', async (req, res) => {
    try {
        const campaignId = req.params.id;
        const campaign = campaigns.get(campaignId);
        
        if (!campaign) {
            return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
        }
        
        campaign.status = 'paused';
        campaign.pausedAt = new Date().toISOString();
        
        const timer = campaignTimers.get(campaignId);
        if (timer) {
            clearTimeout(timer);
            campaignTimers.delete(campaignId);
        }
        
        await saveData();
        
        addLog('CAMPAIGN_PAUSED', `Campanha pausada: ${campaign.name}`, 
            { campaignId }, LOG_LEVELS.INFO);
        
        res.json({ success: true, message: 'Campanha pausada com sucesso' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/campaigns/:id/resume', async (req, res) => {
    try {
        const campaignId = req.params.id;
        const campaign = campaigns.get(campaignId);
        
        if (!campaign) {
            return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
        }
        
        if (campaign.status === 'completed') {
            return res.status(400).json({ 
                success: false, 
                error: 'Campanha já foi concluída' 
            });
        }
        
        campaign.status = 'active';
        campaign.resumedAt = new Date().toISOString();
        delete campaign.pausedAt;
        
        await saveData();
        
        addLog('CAMPAIGN_RESUMED', `Campanha retomada: ${campaign.name}`, 
            { campaignId }, LOG_LEVELS.INFO);
        
        startCampaignProcessing(campaignId);
        
        res.json({ success: true, message: 'Campanha retomada com sucesso' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/campaigns/:id', async (req, res) => {
    try {
        const campaignId = req.params.id;
        const campaign = campaigns.get(campaignId);
        
        if (!campaign) {
            return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
        }
        
        campaign.status = 'cancelled';
        campaign.cancelledAt = new Date().toISOString();
        
        const timer = campaignTimers.get(campaignId);
        if (timer) {
            clearTimeout(timer);
            campaignTimers.delete(campaignId);
        }
        
        campaigns.delete(campaignId);
        campaignInstances.delete(campaignId);
        
        await saveData();
        
        addLog('CAMPAIGN_CANCELLED', `Campanha cancelada: ${campaign.name}`, 
            { campaignId }, LOG_LEVELS.INFO);
        
        res.json({ success: true, message: 'Campanha cancelada com sucesso' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/campaigns/:campaignId/instances/:instance/reactivate', async (req, res) => {
    try {
        const { campaignId, instance } = req.params;
        
        const campaign = campaigns.get(campaignId);
        if (!campaign) {
            return res.status(404).json({ 
                success: false, 
                error: 'Campanha não encontrada' 
            });
        }
        
        const instances = campaignInstances.get(campaignId);
        if (!instances || !instances.has(instance)) {
            return res.status(404).json({ 
                success: false, 
                error: 'Instância não encontrada nesta campanha' 
            });
        }
        
        const instanceState = instances.get(instance);
        instanceState.status = 'active';
        instanceState.consecutiveErrors = 0;
        delete instanceState.pausedReason;
        
        await saveData();
        
        addLog('CAMPAIGN_INSTANCE_REACTIVATED',
            `Instância ${instance} reativada na campanha ${campaign.name}`,
            { campaignId, instance },
            LOG_LEVELS.INFO
        );
        
        if (campaign.status === 'active') {
            startCampaignProcessing(campaignId);
        }
        
        res.json({ 
            success: true, 
            message: `Instância ${instance} reativada com sucesso` 
        });
        
    } catch (error) {
        console.error('Erro ao reativar instância:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ ROTAS - CONVERSAS E LOGS ============
app.get('/api/conversations', (req, res) => {
    const conversationList = Array.from(conversations.values()).map(conv => ({
        ...conv,
        instance: stickyInstances.get(conv.phone) || 'N/A'
    }));
    
    res.json({ 
        success: true, 
        data: conversationList.sort((a, b) => 
            new Date(b.startedAt) - new Date(a.startedAt)
        ).slice(0, 100) 
    });
});

app.get('/api/logs', (req, res) => {
    res.json({ success: true, data: logs.slice(0, 500) });
});

// ============ ROTAS - FRONTEND ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/teste.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'teste.html'));
});

app.get('/logs.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'logs.html'));
});

// ============ INICIALIZAÇÃO ============
async function initializeData() {
    console.log('🔄 Carregando dados...');
    await loadFunnelsFromFile();
    await loadConversationsFromFile();
    await loadPhrasesFromFile();
    await loadManualTriggersFromFile();
    await loadCampaignsFromFile();
    await loadLogsFromFile();
    console.log('✅ Inicialização concluída');
    console.log('📊 Funis:', funis.size);
    console.log('💬 Conversas:', conversations.size);
    console.log('🔑 Frases:', phraseTriggers.size);
    console.log('🎯 Frases Manuais:', manualTriggers.size);
    console.log('🚀 Campanhas:', campaigns.size);
    console.log('📋 Logs:', logs.length);
    
    // Agenda reset diário
    scheduleDailyReset();
    
    // Retoma campanhas ativas
    campaigns.forEach((campaign, id) => {
        if (campaign.status === 'active') {
            addLog('CAMPAIGN_RESUME_STARTUP', `Retomando campanha: ${campaign.name}`, 
                { campaignId: id }, LOG_LEVELS.INFO);
            startCampaignProcessing(id);
        }
    });
}

app.listen(PORT, async () => {
    console.log('='.repeat(70));
    console.log('🚀 KIRVANO SYSTEM V5.5 - SISTEMA COMPLETO + REMARKETING');
    console.log('='.repeat(70));
    console.log('Porta:', PORT);
    console.log('Evolution:', EVOLUTION_BASE_URL);
    console.log('Instâncias:', INSTANCES.length);
    console.log('');
    console.log('✅ NOVIDADES V5.5:');
    console.log('  1. 🚀 CAMPANHAS DE REMARKETING COM PROTEÇÃO ANTI-BAN');
    console.log('  2. ✅ Limite: 10 envios/dia por instância');
    console.log('  3. ✅ Intervalos aleatórios: 40min a 2h');
    console.log('  4. ✅ Horário configurável (padrão 7h-22h)');
    console.log('  5. ✅ Pausa automática após 3 erros consecutivos');
    console.log('  6. ✅ Redistribuição inteligente de contatos');
    console.log('  7. ✅ Reativação manual de instâncias');
    console.log('  8. 🆕 IMPORTAR/EXPORTAR/DELETAR funis');
    console.log('');
    console.log('📡 Endpoints:');
    console.log('  POST /webhook/kirvano           - Eventos Kirvano');
    console.log('  POST /webhook/evolution         - Mensagens WhatsApp');
    console.log('  GET  /api/funnels               - Listar funis');
    console.log('  POST /api/funnels               - Criar funil');
    console.log('  PUT  /api/funnels/:id           - Atualizar funil');
    console.log('  DELETE /api/funnels/:id         - Deletar funil');
    console.log('  POST /api/funnels/import        - Importar funis');
    console.log('  GET  /api/funnels/export        - Exportar funis');
    console.log('  GET  /api/campaigns             - Listar campanhas');
    console.log('  POST /api/campaigns             - Criar campanha');
    console.log('  PUT  /api/campaigns/:id/pause   - Pausar campanha');
    console.log('  PUT  /api/campaigns/:id/resume  - Retomar campanha');
    console.log('  DELETE /api/campaigns/:id       - Cancelar campanha');
    console.log('');
    console.log('🌐 Frontend:');
    console.log('  http://localhost:' + PORT + '           - Dashboard principal');
    console.log('  http://localhost:' + PORT + '/logs.html - Sistema de logs');
    console.log('  http://localhost:' + PORT + '/teste.html - Simulador de testes');
    console.log('='.repeat(70));
    
    await initializeData();
});
