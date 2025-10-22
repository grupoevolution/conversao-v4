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

// ============ SISTEMA DE LOCK ============
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
        // 🔧 CORREÇÃO: Inicializar funis padrão quando arquivo não existe
        funis.clear();
        Object.values(defaultFunnels).forEach(funnel => {
            funis.set(funnel.id, { ...funnel });
        });
        addLog('DEFAULT_FUNNELS_INIT', `Funis padrão inicializados: ${funis.size}`, null, LOG_LEVELS.INFO);
        await saveFunnelsToFile(); // Salvar funis padrão no arquivo
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
        const triggersArray = Array.from(manualTriggers.entries()).map(([id, data]) => ({
            id,
            phrase: data.phrase,
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
            manualTriggers.set(item.id, {
                phrase: item.phrase,
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
            const { key, ...conv} = item;
            conversations.set(key, conv);
            phoneIndex.set(conv.remoteJid, key);
            if (conv.stickyInstance) {
                stickyInstances.set(key, conv.stickyInstance);
            }
        });
        addLog('CONVERSATIONS_LOAD', `Conversas carregadas: ${conversations.size}`, null, LOG_LEVELS.INFO);
        return true;
    } catch (error) {
        addLog('CONVERSATIONS_LOAD_ERROR', 'Nenhuma conversa anterior', null, LOG_LEVELS.DEBUG);
        return false;
    }
}

// 🚀 ============ CAMPANHAS - PERSISTÊNCIA ============
async function saveCampaignsToFile() {
    try {
        await ensureDataDir();
        const campaignsArray = Array.from(campaigns.entries()).map(([id, campaign]) => ({
            id,
            ...campaign,
            instances: Array.from(campaignInstances.get(id) || new Map()).map(([inst, data]) => ({
                instance: inst,
                ...data
            }))
        }));
        await fs.writeFile(CAMPAIGNS_FILE, JSON.stringify(campaignsArray, null, 2));
        addLog('CAMPAIGNS_SAVE', `Campanhas salvas: ${campaignsArray.length}`, null, LOG_LEVELS.DEBUG);
    } catch (error) {
        addLog('CAMPAIGNS_SAVE_ERROR', `Erro: ${error.message}`, null, LOG_LEVELS.ERROR);
    }
}

async function loadCampaignsFromFile() {
    try {
        const data = await fs.readFile(CAMPAIGNS_FILE, 'utf8');
        const campaignsArray = JSON.parse(data);
        campaigns.clear();
        campaignInstances.clear();
        
        campaignsArray.forEach(item => {
            const { id, instances, ...campaign } = item;
            campaigns.set(id, campaign);
            
            // Restaurar estado das instâncias
            const instancesMap = new Map();
            if (instances) {
                instances.forEach(inst => {
                    const { instance, ...data } = inst;
                    instancesMap.set(instance, data);
                });
            }
            campaignInstances.set(id, instancesMap);
        });
        
        addLog('CAMPAIGNS_LOAD', `Campanhas carregadas: ${campaigns.size}`, null, LOG_LEVELS.INFO);
        return true;
    } catch (error) {
        addLog('CAMPAIGNS_LOAD_ERROR', 'Nenhuma campanha anterior', null, LOG_LEVELS.DEBUG);
        return false;
    }
}

// 🚀 ============ CAMPANHAS - FUNÇÕES AUXILIARES ============

// Gera intervalo aleatório entre MIN e MAX
function getRandomInterval() {
    const min = CAMPAIGN_CONFIG.MIN_INTERVAL;
    const max = CAMPAIGN_CONFIG.MAX_INTERVAL;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Verifica se está dentro do horário permitido (Timezone Brasília)
function isWithinWorkingHours(startHour, endHour) {
    const now = new Date();
    const brasiliaTime = new Date(now.toLocaleString('en-US', { timeZone: CAMPAIGN_CONFIG.TIMEZONE }));
    const currentHour = brasiliaTime.getHours();
    return currentHour >= startHour && currentHour < endHour;
}

// Calcula próximo horário válido (Timezone Brasília)
function getNextValidTime(startHour, endHour) {
    const now = new Date();
    const brasiliaTime = new Date(now.toLocaleString('en-US', { timeZone: CAMPAIGN_CONFIG.TIMEZONE }));
    const currentHour = brasiliaTime.getHours();
    
    // Se está antes do horário, agenda para o startHour de hoje
    if (currentHour < startHour) {
        const next = new Date(brasiliaTime);
        next.setHours(startHour, 0, 0, 0);
        return next.getTime() - brasiliaTime.getTime();
    }
    
    // Se está depois do horário, agenda para o startHour de amanhã
    if (currentHour >= endHour) {
        const next = new Date(brasiliaTime);
        next.setDate(next.getDate() + 1);
        next.setHours(startHour, 0, 0, 0);
        return next.getTime() - brasiliaTime.getTime();
    }
    
    // Está dentro do horário
    return 0;
}

// Valida número de telefone
function validatePhoneNumber(phone) {
    const cleaned = String(phone).replace(/\D/g, '');
    
    // Deve ter DDI + DDD + número (mínimo 12 dígitos)
    if (cleaned.length < 12 || cleaned.length > 15) {
        return null;
    }
    
    return cleaned;
}

// Reseta contadores diários (chamado à meia-noite)
function resetDailyCounters() {
    campaigns.forEach((campaign, campaignId) => {
        const instances = campaignInstances.get(campaignId);
        if (instances) {
            instances.forEach((data, instance) => {
                data.sentToday = 0;
                data.todayResetAt = new Date().toISOString();
            });
        }
    });
    saveCampaignsToFile();
    addLog('CAMPAIGNS_DAILY_RESET', 'Contadores diários resetados', null, LOG_LEVELS.INFO);
}

// Agenda reset diário à meia-noite
function scheduleDailyReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const timeUntilMidnight = tomorrow.getTime() - now.getTime();
    
    setTimeout(() => {
        resetDailyCounters();
        scheduleDailyReset(); // Reagenda para o próximo dia
    }, timeUntilMidnight);
    
    addLog('CAMPAIGNS_SCHEDULE_RESET', `Próximo reset em ${Math.round(timeUntilMidnight / 1000 / 60)} minutos`, 
        null, LOG_LEVELS.DEBUG);
}

// 🚀 ============ CAMPANHAS - ENVIO ============

async function sendCampaignMessage(campaignId, contact, instance, funnelId) {
    try {
        const funnel = funis.get(funnelId);
        if (!funnel || !funnel.steps || funnel.steps.length === 0) {
            throw new Error('Funil não encontrado ou vazio');
        }

        const phoneKey = `campaign_${campaignId}_${contact}`;
        const remoteJid = contact + '@s.whatsapp.net';

        // Cria conversa para o funil
        conversations.set(phoneKey, {
            remoteJid,
            funnelId,
            stepIndex: 0,
            waiting_for_response: false,
            createdAt: new Date().toISOString(),
            source: 'campaign',
            campaignId,
            stickyInstance: instance
        });

        phoneIndex.set(remoteJid, phoneKey);
        stickyInstances.set(phoneKey, instance);

        // Envia primeiro bloco do funil
        const firstStep = funnel.steps[0];
        await sendStep(phoneKey, firstStep, instance);

        addLog('CAMPAIGN_MESSAGE_SENT', `Mensagem enviada`, {
            campaignId,
            contact,
            instance,
            funnel: funnelId
        }, LOG_LEVELS.INFO);

        return true;
    } catch (error) {
        addLog('CAMPAIGN_MESSAGE_ERROR', `Erro ao enviar: ${error.message}`, {
            campaignId,
            contact,
            instance
        }, LOG_LEVELS.ERROR);
        return false;
    }
}

// Processa fila de uma instância específica
async function processCampaignInstance(campaignId, instance) {
    const campaign = campaigns.get(campaignId);
    if (!campaign || campaign.status !== 'active') {
        return;
    }

    const instances = campaignInstances.get(campaignId);
    const instanceData = instances.get(instance);

    // Verifica se instância está pausada
    if (instanceData.status === 'paused') {
        addLog('CAMPAIGN_INSTANCE_PAUSED', `Instância pausada`, {
            campaignId,
            instance
        }, LOG_LEVELS.WARNING);
        return;
    }

    // Verifica limite diário
    const maxDailyLimit = campaign.config.dailyLimit || CAMPAIGN_CONFIG.DEFAULT_DAILY_LIMIT;
    
    if (instanceData.sentToday >= maxDailyLimit) {
        addLog('CAMPAIGN_DAILY_LIMIT', `Limite diário atingido`, {
            campaignId,
            instance,
            sent: instanceData.sentToday,
            limit: maxDailyLimit
        }, LOG_LEVELS.INFO);
        
        // Agenda para amanhã
        const nextDelay = getNextValidTime(campaign.config.startHour, campaign.config.endHour);
        setTimeout(() => processCampaignInstance(campaignId, instance), nextDelay);
        return;
    }

    // Verifica horário de trabalho
    if (!isWithinWorkingHours(campaign.config.startHour, campaign.config.endHour)) {
        const nextDelay = getNextValidTime(campaign.config.startHour, campaign.config.endHour);
        addLog('CAMPAIGN_OUTSIDE_HOURS', `Fora do horário - aguardando`, {
            campaignId,
            instance,
            nextIn: Math.round(nextDelay / 1000 / 60) + ' minutos'
        }, LOG_LEVELS.DEBUG);
        
        setTimeout(() => processCampaignInstance(campaignId, instance), nextDelay);
        return;
    }

    // Pega próximo contato da fila desta instância
    const contact = instanceData.queue.shift();
    
    if (!contact) {
        // Fila vazia - campanha concluída para esta instância
        addLog('CAMPAIGN_INSTANCE_COMPLETE', `Fila vazia`, {
            campaignId,
            instance
        }, LOG_LEVELS.INFO);
        
        // Verifica se todas as instâncias terminaram
        let allComplete = true;
        instances.forEach((data) => {
            if (data.queue.length > 0) {
                allComplete = false;
            }
        });
        
        if (allComplete) {
            campaign.status = 'completed';
            campaign.completedAt = new Date().toISOString();
            saveCampaignsToFile();
            
            addLog('CAMPAIGN_COMPLETED', `Campanha concluída`, {
                campaignId,
                totalSent: campaign.stats.sent
            }, LOG_LEVELS.INFO);
        }
        
        return;
    }

    // Envia mensagem
    const success = await sendCampaignMessage(campaignId, contact, instance, campaign.funnelId);

    if (success) {
        // Sucesso - atualiza estatísticas
        campaign.stats.sent++;
        instanceData.sentToday++;
        instanceData.totalSent++;
        instanceData.consecutiveErrors = 0;
        instanceData.lastSentAt = new Date().toISOString();
        
        addLog('CAMPAIGN_SEND_SUCCESS', `Enviado com sucesso`, {
            campaignId,
            instance,
            contact,
            sentToday: instanceData.sentToday
        }, LOG_LEVELS.INFO);
    } else {
        // Erro - incrementa contador de erros
        campaign.stats.errors++;
        instanceData.consecutiveErrors++;
        
        addLog('CAMPAIGN_SEND_ERROR', `Erro no envio`, {
            campaignId,
            instance,
            contact,
            consecutiveErrors: instanceData.consecutiveErrors
        }, LOG_LEVELS.ERROR);
        
        // Se atingiu limite de erros, pausa a instância
        if (instanceData.consecutiveErrors >= CAMPAIGN_CONFIG.MAX_CONSECUTIVE_ERRORS) {
            instanceData.status = 'paused';
            instanceData.pausedAt = new Date().toISOString();
            instanceData.pauseReason = 'Múltiplos erros consecutivos';
            
            addLog('CAMPAIGN_INSTANCE_AUTO_PAUSED', `Instância pausada automaticamente`, {
                campaignId,
                instance,
                errors: instanceData.consecutiveErrors
            }, LOG_LEVELS.CRITICAL);
            
            // Redistribui contato para próxima instância disponível
            const nextInstance = findNextAvailableInstance(campaignId, instance);
            if (nextInstance) {
                const nextData = instances.get(nextInstance);
                nextData.queue.unshift(contact); // Adiciona no início da fila
                
                addLog('CAMPAIGN_CONTACT_REDISTRIBUTED', `Contato redistribuído`, {
                    campaignId,
                    from: instance,
                    to: nextInstance,
                    contact
                }, LOG_LEVELS.INFO);
            } else {
                // Nenhuma instância disponível - contato perdido
                campaign.stats.errors++;
                addLog('CAMPAIGN_NO_INSTANCE_AVAILABLE', `Nenhuma instância disponível`, {
                    campaignId,
                    contact
                }, LOG_LEVELS.CRITICAL);
            }
            
            saveCampaignsToFile();
            return; // Para execução desta instância
        } else {
            // Recoloca contato no início da fila para tentar novamente
            instanceData.queue.unshift(contact);
        }
    }

    saveCampaignsToFile();

    // Agenda próximo envio com intervalo aleatório
    const nextInterval = getRandomInterval();
    instanceData.nextSendAt = new Date(Date.now() + nextInterval).toISOString();
    
    addLog('CAMPAIGN_NEXT_SCHEDULED', `Próximo envio agendado`, {
        campaignId,
        instance,
        inMinutes: Math.round(nextInterval / 1000 / 60)
    }, LOG_LEVELS.DEBUG);
    
    setTimeout(() => processCampaignInstance(campaignId, instance), nextInterval);
}

// Encontra próxima instância disponível (sequencial, pulando pausadas)
function findNextAvailableInstance(campaignId, currentInstance) {
    const campaign = campaigns.get(campaignId);
    const instances = campaignInstances.get(campaignId);
    if (!instances || !campaign) return null;
    
    const maxDailyLimit = campaign.config.dailyLimit || CAMPAIGN_CONFIG.DEFAULT_DAILY_LIMIT;
    const instancesList = Array.from(instances.keys());
    const currentIndex = instancesList.indexOf(currentInstance);
    
    // Procura a partir da próxima instância
    for (let i = 1; i < instancesList.length; i++) {
        const nextIndex = (currentIndex + i) % instancesList.length;
        const nextInstance = instancesList[nextIndex];
        const nextData = instances.get(nextInstance);
        
        if (nextData.status === 'active' && nextData.sentToday < maxDailyLimit) {
            return nextInstance;
        }
    }
    
    return null;
}

// Inicia processamento da campanha
function startCampaignProcessing(campaignId) {
    const campaign = campaigns.get(campaignId);
    const instances = campaignInstances.get(campaignId);
    
    if (!campaign || !instances) {
        addLog('CAMPAIGN_START_ERROR', 'Campanha ou instâncias não encontradas', 
            { campaignId }, LOG_LEVELS.ERROR);
        return;
    }
    
    addLog('CAMPAIGN_STARTED', `Iniciando processamento`, {
        campaignId,
        totalContacts: campaign.totalContacts,
        instances: instances.size
    }, LOG_LEVELS.INFO);
    
    // Inicia cada instância
    instances.forEach((data, instance) => {
        if (data.status === 'active' && data.queue.length > 0) {
            // Adiciona delay inicial variável para cada instância
            const initialDelay = Math.floor(Math.random() * 60000); // 0-1 minuto
            
            setTimeout(() => {
                processCampaignInstance(campaignId, instance);
            }, initialDelay);
            
            addLog('CAMPAIGN_INSTANCE_SCHEDULED', `Instância agendada`, {
                campaignId,
                instance,
                queueSize: data.queue.length,
                initialDelaySeconds: Math.round(initialDelay / 1000)
            }, LOG_LEVELS.INFO);
        }
    });
}

// ============ ENVIO DE MENSAGENS (Kirvano + Campanhas) ============
async function sendToEvolution(instance, endpoint, payload) {
    const url = `${EVOLUTION_BASE_URL}${endpoint}${instance}`;
    
    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 30000
        });
        
        addLog('EVOLUTION_SUCCESS', `Mensagem enviada via ${instance}`, 
            { endpoint, instance }, LOG_LEVELS.DEBUG);
        return response.data;
    } catch (error) {
        addLog('EVOLUTION_ERROR', `Erro ao enviar via ${instance}: ${error.message}`, 
            { endpoint, instance, error: error.response?.data }, LOG_LEVELS.ERROR);
        throw error;
    }
}

async function sendStep(phoneKey, step, instance) {
    const conv = conversations.get(phoneKey);
    if (!conv) return;

    const remoteJid = conv.remoteJid;
    const number = remoteJid.replace('@s.whatsapp.net', '');

    try {
        switch (step.type) {
            case 'text':
                await sendToEvolution(instance, '/message/sendText/', {
                    number,
                    text: step.content
                });
                break;

            case 'image':
                await sendToEvolution(instance, '/message/sendMedia/', {
                    number,
                    mediatype: 'image',
                    media: step.url,
                    caption: step.caption || ''
                });
                break;

            case 'video':
                await sendToEvolution(instance, '/message/sendMedia/', {
                    number,
                    mediatype: 'video',
                    media: step.url,
                    caption: step.caption || ''
                });
                break;

            case 'audio':
                await sendToEvolution(instance, '/message/sendWhatsAppAudio/', {
                    number,
                    audio: step.url
                });
                break;

            case 'document':
                await sendToEvolution(instance, '/message/sendMedia/', {
                    number,
                    mediatype: 'document',
                    media: step.url,
                    fileName: step.fileName || 'documento.pdf'
                });
                break;

            case 'delay':
                // Não faz nada, apenas delay
                break;

            case 'wait_response':
                conv.waiting_for_response = true;
                conversations.set(phoneKey, conv);
                break;
        }

        conv.lastSystemMessage = new Date().toISOString();
        conversations.set(phoneKey, conv);
        await saveConversationsToFile();

    } catch (error) {
        addLog('SEND_STEP_ERROR', `Erro ao enviar passo: ${error.message}`, 
            { phoneKey, stepType: step.type }, LOG_LEVELS.ERROR);
        throw error;
    }
}

async function processNextStep(phoneKey) {
    const conv = conversations.get(phoneKey);
    if (!conv) return;

    const funnel = funis.get(conv.funnelId);
    if (!funnel || !funnel.steps) return;

    conv.stepIndex++;

    if (conv.stepIndex >= funnel.steps.length) {
        conv.completed = true;
        conversations.set(phoneKey, conv);
        await saveConversationsToFile();
        
        addLog('FUNNEL_COMPLETED', 'Funil concluído', { phoneKey }, LOG_LEVELS.INFO);
        return;
    }

    const nextStep = funnel.steps[conv.stepIndex];
    conversations.set(phoneKey, conv);

    if (nextStep.type === 'delay') {
        const delayMs = (nextStep.seconds || 5) * 1000;
        setTimeout(() => processNextStep(phoneKey), delayMs);
        return;
    }

    const instance = stickyInstances.get(phoneKey) || INSTANCES[0];
    await sendStep(phoneKey, nextStep, instance);

    if (nextStep.type !== 'wait_response') {
        setTimeout(() => processNextStep(phoneKey), 2000);
    }
}

// ============ WEBHOOK EVOLUTION (Mensagens recebidas) ============
app.post('/webhook/evolution', async (req, res) => {
    try {
        res.status(200).json({ success: true, message: 'Recebido' });

        const { data } = req.body;
        if (!data || !data.key || !data.key.remoteJid) return;

        const remoteJid = data.key.remoteJid;
        if (!remoteJid.endsWith('@s.whatsapp.net')) return;

        const messageText = data.message?.conversation || 
                          data.message?.extendedTextMessage?.text || 
                          '';

        if (!messageText) return;

        const phoneKey = phoneIndex.get(remoteJid) || remoteJid;

        // Adquire lock para evitar race conditions
        const lockAcquired = await acquireWebhookLock(phoneKey);
        if (!lockAcquired) {
            addLog('WEBHOOK_LOCK_FAILED', 'Lock não adquirido', { phoneKey }, LOG_LEVELS.WARNING);
            return;
        }

        try {
            const existingConv = conversations.get(phoneKey);

            // Se já tem conversa ativa e está aguardando resposta
            if (existingConv && existingConv.waiting_for_response) {
                existingConv.waiting_for_response = false;
                existingConv.lastReply = new Date().toISOString();
                conversations.set(phoneKey, existingConv);
                await saveConversationsToFile();

                addLog('USER_REPLY', 'Resposta recebida, continuando funil', 
                    { phoneKey }, LOG_LEVELS.INFO);

                await processNextStep(phoneKey);
                return;
            }

            // Verifica frases-chave automáticas (cliente envia)
            const normalizedMessage = messageText.toLowerCase().trim();
            
            for (const [phrase, triggerData] of phraseTriggers.entries()) {
                if (!triggerData.active) continue;

                if (normalizedMessage.includes(phrase)) {
                    // Verifica cooldown de 24h
                    const cooldownKey = `${remoteJid}_${phrase}`;
                    const lastTrigger = phraseCooldowns.get(cooldownKey);
                    
                    if (lastTrigger && (Date.now() - lastTrigger) < PHRASE_COOLDOWN) {
                        addLog('PHRASE_COOLDOWN', 'Frase em cooldown', 
                            { phoneKey, phrase }, LOG_LEVELS.DEBUG);
                        return;
                    }

                    // Registra cooldown
                    phraseCooldowns.set(cooldownKey, Date.now());

                    // Cria nova conversa
                    const newPhoneKey = `phrase_${Date.now()}_${remoteJid}`;
                    const instance = INSTANCES[Math.floor(Math.random() * INSTANCES.length)];

                    conversations.set(newPhoneKey, {
                        remoteJid,
                        funnelId: triggerData.funnelId,
                        stepIndex: 0,
                        waiting_for_response: false,
                        createdAt: new Date().toISOString(),
                        source: 'phrase',
                        triggerPhrase: phrase
                    });

                    phoneIndex.set(remoteJid, newPhoneKey);
                    stickyInstances.set(newPhoneKey, instance);

                    triggerData.triggerCount++;
                    await savePhrasesToFile();
                    await saveConversationsToFile();

                    addLog('PHRASE_TRIGGERED', 'Frase detectada, disparando funil', 
                        { phrase, funnelId: triggerData.funnelId }, LOG_LEVELS.INFO);

                    await processNextStep(newPhoneKey);
                    return;
                }
            }

            // Verifica frases manuais (você envia)
            if (data.key.fromMe) {
                for (const [id, triggerData] of manualTriggers.entries()) {
                    if (!triggerData.active) continue;

                    if (normalizedMessage.includes(triggerData.phrase)) {
                        const newPhoneKey = `manual_${Date.now()}_${remoteJid}`;
                        const instance = data.key.id.split(':')[0] || INSTANCES[0];

                        conversations.set(newPhoneKey, {
                            remoteJid,
                            funnelId: triggerData.funnelId,
                            stepIndex: 0,
                            waiting_for_response: false,
                            createdAt: new Date().toISOString(),
                            source: 'manual',
                            triggerPhrase: triggerData.phrase
                        });

                        phoneIndex.set(remoteJid, newPhoneKey);
                        stickyInstances.set(newPhoneKey, instance);

                        triggerData.triggerCount++;
                        await saveManualTriggersToFile();
                        await saveConversationsToFile();

                        addLog('MANUAL_TRIGGER_ACTIVATED', 'Frase manual detectada', 
                            { phrase: triggerData.phrase, funnelId: triggerData.funnelId }, 
                            LOG_LEVELS.INFO);

                        await processNextStep(newPhoneKey);
                        return;
                    }
                }
            }

        } finally {
            releaseWebhookLock(phoneKey);
        }

    } catch (error) {
        addLog('WEBHOOK_ERROR', `Erro no webhook: ${error.message}`, 
            null, LOG_LEVELS.ERROR);
    }
});

// ============ WEBHOOK KIRVANO (Compras/PIX) ============
app.post('/webhook/kirvano', async (req, res) => {
    try {
        res.status(200).json({ success: true, message: 'Webhook recebido' });

        const { product_id, customer, status, order } = req.body;

        if (!product_id || !customer?.phone) {
            addLog('KIRVANO_INVALID', 'Dados inválidos', req.body, LOG_LEVELS.WARNING);
            return;
        }

        const productType = PRODUCT_MAPPING[product_id];
        if (!productType) {
            addLog('KIRVANO_UNKNOWN_PRODUCT', 'Produto desconhecido', 
                { product_id }, LOG_LEVELS.WARNING);
            return;
        }

        const phone = customer.phone.replace(/\D/g, '');
        const remoteJid = phone + '@s.whatsapp.net';
        
        let funnelId;
        if (status === 'approved') {
            funnelId = `${productType}_APROVADA`;
        } else if (status === 'pending' && order?.payment_method === 'pix') {
            funnelId = `${productType}_PIX`;
        } else {
            addLog('KIRVANO_INVALID_STATUS', 'Status não mapeado', 
                { status, payment_method: order?.payment_method }, LOG_LEVELS.DEBUG);
            return;
        }

        const funnel = funis.get(funnelId);
        if (!funnel) {
            addLog('KIRVANO_FUNNEL_NOT_FOUND', 'Funil não existe', 
                { funnelId }, LOG_LEVELS.ERROR);
            return;
        }

        // Pega instância disponível
        let instance = INSTANCES[0];
        lastSuccessfulInstanceIndex = (lastSuccessfulInstanceIndex + 1) % INSTANCES.length;
        instance = INSTANCES[lastSuccessfulInstanceIndex];

        const phoneKey = `kirvano_${Date.now()}_${phone}`;

        conversations.set(phoneKey, {
            remoteJid,
            customerName: customer.name || 'Cliente',
            productType,
            funnelId,
            stepIndex: 0,
            waiting_for_response: false,
            createdAt: new Date().toISOString(),
            orderCode: order?.code,
            amount: order?.amount,
            source: 'kirvano',
            pixWaiting: status === 'pending'
        });

        phoneIndex.set(remoteJid, phoneKey);
        stickyInstances.set(phoneKey, instance);

        await saveConversationsToFile();

        addLog('KIRVANO_FUNNEL_STARTED', 'Funil iniciado', {
            phoneKey,
            funnelId,
            productType,
            customer: customer.name
        }, LOG_LEVELS.INFO);

        // PIX: agenda timeout de 7 minutos
        if (status === 'pending') {
            const timeoutId = setTimeout(async () => {
                const conv = conversations.get(phoneKey);
                if (conv && conv.pixWaiting && !conv.transferredFromPix) {
                    addLog('PIX_TIMEOUT', 'Timeout do PIX - cancelando', 
                        { phoneKey }, LOG_LEVELS.WARNING);
                    conv.canceled = true;
                    conv.pixWaiting = false;
                    conversations.set(phoneKey, conv);
                    await saveConversationsToFile();
                }
                pixTimeouts.delete(phoneKey);
            }, PIX_TIMEOUT);
            
            pixTimeouts.set(phoneKey, timeoutId);
        }

        await processNextStep(phoneKey);

    } catch (error) {
        addLog('KIRVANO_WEBHOOK_ERROR', `Erro: ${error.message}`, 
            null, LOG_LEVELS.ERROR);
    }
});

// ============ API ENDPOINTS ============

// Dashboard stats
app.get('/api/stats', (req, res) => {
    const activeCampaigns = Array.from(campaigns.values())
        .filter(c => c.status === 'active').length;

    res.json({
        success: true,
        data: {
            active_conversations: conversations.size,
            pending_pix: Array.from(conversations.values()).filter(c => c.pixWaiting).length,
            total_funnels: funis.size,
            total_phrases: phraseTriggers.size,
            active_campaigns: activeCampaigns
        }
    });
});

// Funis
app.get('/api/funnels', (req, res) => {
    const funnelsArray = Array.from(funis.values());
    res.json({ success: true, data: funnelsArray });
});

app.get('/api/funnels/:id', (req, res) => {
    const funnel = funis.get(req.params.id);
    if (!funnel) {
        return res.status(404).json({ success: false, error: 'Funil não encontrado' });
    }
    res.json({ success: true, data: funnel });
});

app.post('/api/funnels', async (req, res) => {
    const { id, name, steps } = req.body;
    
    if (!id || !name) {
        return res.status(400).json({ success: false, error: 'Dados inválidos' });
    }
    
    funis.set(id, { id, name, steps: steps || [] });
    await saveFunnelsToFile();
    
    addLog('FUNNEL_CREATED', `Funil criado: ${name}`, { id }, LOG_LEVELS.INFO);
    res.json({ success: true, message: 'Funil criado', data: { id, name } });
});

app.put('/api/funnels/:id', async (req, res) => {
    const { id } = req.params;
    const { name, steps } = req.body;
    
    const funnel = funis.get(id);
    if (!funnel) {
        return res.status(404).json({ success: false, error: 'Funil não encontrado' });
    }
    
    if (name) funnel.name = name;
    if (steps) funnel.steps = steps;
    
    funis.set(id, funnel);
    await saveFunnelsToFile();
    
    addLog('FUNNEL_UPDATED', `Funil atualizado: ${funnel.name}`, { id }, LOG_LEVELS.INFO);
    res.json({ success: true, message: 'Funil atualizado' });
});

// Frases-chave
app.get('/api/phrases', (req, res) => {
    const phrasesArray = Array.from(phraseTriggers.entries()).map(([phrase, data]) => ({
        phrase,
        funnelId: data.funnelId,
        funnelName: funis.get(data.funnelId)?.name,
        active: data.active,
        triggerCount: data.triggerCount
    }));
    res.json({ success: true, data: phrasesArray });
});

app.post('/api/phrases', async (req, res) => {
    const { phrase, funnelId } = req.body;
    
    if (!phrase || !funnelId) {
        return res.status(400).json({ success: false, error: 'Dados inválidos' });
    }
    
    const normalizedPhrase = phrase.toLowerCase().trim();
    
    phraseTriggers.set(normalizedPhrase, {
        funnelId,
        active: true,
        triggerCount: 0
    });
    
    await savePhrasesToFile();
    
    addLog('PHRASE_CREATED', `Frase cadastrada: ${normalizedPhrase}`, 
        { funnelId }, LOG_LEVELS.INFO);
    res.json({ success: true, message: 'Frase cadastrada' });
});

app.delete('/api/phrases/:phrase', async (req, res) => {
    const phrase = decodeURIComponent(req.params.phrase);
    
    if (!phraseTriggers.has(phrase)) {
        return res.status(404).json({ success: false, error: 'Frase não encontrada' });
    }
    
    phraseTriggers.delete(phrase);
    await savePhrasesToFile();
    
    addLog('PHRASE_DELETED', `Frase excluída: ${phrase}`, null, LOG_LEVELS.INFO);
    res.json({ success: true, message: 'Frase excluída' });
});

// Frases manuais
app.get('/api/manual-triggers', (req, res) => {
    const triggersArray = Array.from(manualTriggers.entries()).map(([id, data]) => ({
        id,
        phrase: data.phrase,
        funnelId: data.funnelId,
        funnelName: funis.get(data.funnelId)?.name,
        active: data.active,
        triggerCount: data.triggerCount
    }));
    res.json({ success: true, data: triggersArray });
});

app.post('/api/manual-triggers', async (req, res) => {
    const { phrase, funnelId } = req.body;
    
    if (!phrase || !funnelId) {
        return res.status(400).json({ success: false, error: 'Dados inválidos' });
    }
    
    const id = `MANUAL_${Date.now()}`;
    const normalizedPhrase = phrase.toLowerCase().trim();
    
    manualTriggers.set(id, {
        phrase: normalizedPhrase,
        funnelId,
        active: true,
        triggerCount: 0
    });
    
    await saveManualTriggersToFile();
    
    addLog('MANUAL_TRIGGER_CREATED', `Frase manual cadastrada: ${normalizedPhrase}`, 
        { id, funnelId }, LOG_LEVELS.INFO);
    res.json({ success: true, message: 'Frase manual cadastrada', data: { id } });
});

app.delete('/api/manual-triggers/:id', async (req, res) => {
    const { id } = req.params;
    
    if (!manualTriggers.has(id)) {
        return res.status(404).json({ success: false, error: 'Frase não encontrada' });
    }
    
    manualTriggers.delete(id);
    await saveManualTriggersToFile();
    
    addLog('MANUAL_TRIGGER_DELETED', `Frase manual excluída`, { id }, LOG_LEVELS.INFO);
    res.json({ success: true, message: 'Frase manual excluída' });
});

// 🚀 ============ API CAMPANHAS ============

app.get('/api/campaigns', (req, res) => {
    const campaignsArray = Array.from(campaigns.entries()).map(([id, campaign]) => {
        const instances = campaignInstances.get(id);
        const instancesData = instances ? Array.from(instances.entries()).map(([inst, data]) => ({
            instance: inst,
            status: data.status,
            sentToday: data.sentToday,
            totalSent: data.totalSent,
            queueSize: data.queue.length,
            consecutiveErrors: data.consecutiveErrors,
            lastSentAt: data.lastSentAt,
            nextSendAt: data.nextSendAt,
            pausedAt: data.pausedAt,
            pauseReason: data.pauseReason
        })) : [];

        return {
            id,
            ...campaign,
            funnelName: funis.get(campaign.funnelId)?.name,
            instancesStatus: instancesData
        };
    });
    
    res.json({ success: true, data: campaignsArray });
});

app.post('/api/campaigns', async (req, res) => {
    try {
        const { name, funnelId, contacts, config } = req.body;
        
        if (!name || !funnelId || !contacts || !Array.isArray(contacts) || contacts.length === 0) {
            return res.status(400).json({ success: false, error: 'Dados inválidos' });
        }
        
        if (!funis.has(funnelId)) {
            return res.status(400).json({ success: false, error: 'Funil não encontrado' });
        }
        
        // Valida todos os contatos
        const validContacts = contacts
            .map(c => validatePhoneNumber(c))
            .filter(c => c !== null);
        
        if (validContacts.length === 0) {
            return res.status(400).json({ success: false, error: 'Nenhum contato válido' });
        }
        
        const campaignId = 'CAMP_' + Date.now();
        
        // Configura campanha
        const campaign = {
            id: campaignId,
            name,
            funnelId,
            status: 'active',
            totalContacts: validContacts.length,
            stats: {
                sent: 0,
                errors: 0
            },
            config: {
                dailyLimit: config?.dailyLimit || CAMPAIGN_CONFIG.DEFAULT_DAILY_LIMIT,
                startHour: config?.startHour || CAMPAIGN_CONFIG.DEFAULT_START_HOUR,
                endHour: config?.endHour || CAMPAIGN_CONFIG.DEFAULT_END_HOUR
            },
            createdAt: new Date().toISOString()
        };
        
        campaigns.set(campaignId, campaign);
        
        // Distribui contatos sequencialmente entre instâncias
        const instancesMap = new Map();
        
        INSTANCES.forEach(instance => {
            instancesMap.set(instance, {
                status: 'active',
                queue: [],
                sentToday: 0,
                totalSent: 0,
                consecutiveErrors: 0,
                todayResetAt: new Date().toISOString()
            });
        });
        
        // Distribuição circular
        validContacts.forEach((contact, index) => {
            const instanceIndex = index % INSTANCES.length;
            const instance = INSTANCES[instanceIndex];
            const data = instancesMap.get(instance);
            data.queue.push(contact);
        });
        
        campaignInstances.set(campaignId, instancesMap);
        
        await saveCampaignsToFile();
        
        addLog('CAMPAIGN_CREATED', `Campanha criada: ${name}`, {
            campaignId,
            totalContacts: validContacts.length,
            instances: INSTANCES.length
        }, LOG_LEVELS.INFO);
        
        // Inicia processamento
        startCampaignProcessing(campaignId);
        
        res.json({ 
            success: true, 
            message: 'Campanha criada e iniciada',
            data: { 
                campaignId,
                totalContacts: validContacts.length,
                invalidContacts: contacts.length - validContacts.length
            }
        });
        
    } catch (error) {
        addLog('CAMPAIGN_CREATE_ERROR', `Erro ao criar campanha: ${error.message}`, 
            null, LOG_LEVELS.ERROR);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/campaigns/:id/pause', async (req, res) => {
    const campaignId = req.params.id;
    const campaign = campaigns.get(campaignId);
    
    if (!campaign) {
        return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
    }
    
    campaign.status = 'paused';
    campaign.pausedAt = new Date().toISOString();
    campaigns.set(campaignId, campaign);
    await saveCampaignsToFile();
    
    addLog('CAMPAIGN_PAUSED', `Campanha pausada manualmente`, { campaignId }, LOG_LEVELS.INFO);
    
    res.json({ success: true, message: 'Campanha pausada' });
});

app.put('/api/campaigns/:id/resume', async (req, res) => {
    const campaignId = req.params.id;
    const campaign = campaigns.get(campaignId);
    
    if (!campaign) {
        return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
    }
    
    campaign.status = 'active';
    campaign.pausedAt = null;
    campaigns.set(campaignId, campaign);
    await saveCampaignsToFile();
    
    // Reinicia processamento
    startCampaignProcessing(campaignId);
    
    addLog('CAMPAIGN_RESUMED', `Campanha retomada`, { campaignId }, LOG_LEVELS.INFO);
    
    res.json({ success: true, message: 'Campanha retomada' });
});

app.delete('/api/campaigns/:id', async (req, res) => {
    const campaignId = req.params.id;
    const campaign = campaigns.get(campaignId);
    
    if (!campaign) {
        return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
    }
    
    campaign.status = 'cancelled';
    campaign.cancelledAt = new Date().toISOString();
    campaigns.set(campaignId, campaign);
    await saveCampaignsToFile();
    
    addLog('CAMPAIGN_CANCELLED', `Campanha cancelada`, { campaignId }, LOG_LEVELS.INFO);
    
    res.json({ success: true, message: 'Campanha cancelada' });
});

// Reativar instância pausada
app.put('/api/campaigns/:campaignId/instances/:instance/reactivate', async (req, res) => {
    const { campaignId, instance } = req.params;
    
    const campaign = campaigns.get(campaignId);
    if (!campaign) {
        return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
    }
    
    const instances = campaignInstances.get(campaignId);
    if (!instances || !instances.has(instance)) {
        return res.status(404).json({ success: false, error: 'Instância não encontrada' });
    }
    
    const instanceData = instances.get(instance);
    instanceData.status = 'active';
    instanceData.consecutiveErrors = 0;
    instanceData.pausedAt = null;
    instanceData.pauseReason = null;
    
    await saveCampaignsToFile();
    
    addLog('CAMPAIGN_INSTANCE_REACTIVATED', `Instância reativada manualmente`, {
        campaignId,
        instance
    }, LOG_LEVELS.INFO);
    
    // Reinicia processamento desta instância
    if (campaign.status === 'active') {
        processCampaignInstance(campaignId, instance);
    }
    
    res.json({ success: true, message: 'Instância reativada' });
});

// Conversas
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
        source: conv.source || 'kirvano',
        campaignId: conv.campaignId
    }));
    
    conversationsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ success: true, data: conversationsList });
});

// Logs
app.get('/api/logs', (req, res) => {
    res.json({ success: true, data: logs });
});

// Páginas
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
    console.log('');
    console.log('📡 Endpoints:');
    console.log('  POST /webhook/kirvano           - Eventos Kirvano');
    console.log('  POST /webhook/evolution         - Mensagens WhatsApp');
    console.log('  GET  /api/campaigns             - Listar campanhas');
    console.log('  POST /api/campaigns             - Criar campanha');
    console.log('  PUT  /api/campaigns/:id/pause   - Pausar campanha');
    console.log('  PUT  /api/campaigns/:id/resume  - Retomar campanha');
    console.log('  DELETE /api/campaigns/:id       - Cancelar campanha');
    console.log('  PUT  /api/campaigns/:id/instances/:inst/reactivate - Reativar instância');
    console.log('');
    console.log('🌐 Frontend:');
    console.log('  http://localhost:' + PORT + '           - Dashboard principal');
    console.log('  http://localhost:' + PORT + '/logs.html - Sistema de logs');
    console.log('  http://localhost:' + PORT + '/teste.html - Simulador de testes');
    console.log('='.repeat(70));
    
    await initializeData();
});
