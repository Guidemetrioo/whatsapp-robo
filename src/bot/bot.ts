import { Client, LocalAuth } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
import { startReminderLoop } from "./reminder";
import { getSupabase } from "./db";
import { handleIncomingMessage } from "./flow";

// 1. Manually load .env.local to ensure environment variables are present
function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      
      const parts = trimmed.split("=");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        let val = parts.slice(1).join("=").trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
    console.log("✅ Variáveis de ambiente de .env.local carregadas com sucesso.");
  } else {
    console.warn("⚠️ Arquivo .env.local não encontrado no diretório atual.");
  }
}

loadEnv();

// 2. Locate local Chrome or Edge installation (Cross-platform)
function getChromeExecutablePath(): string | undefined {
  if (process.platform === "win32") {
    const possiblePaths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        console.log(`🔍 Navegador Chromium encontrado em: ${p}`);
        return p;
      }
    }
  } else {
    // Linux/macOS standard paths
    const possiblePaths = [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/brave-browser",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        console.log(`🔍 Navegador Chromium encontrado em: ${p}`);
        return p;
      }
    }
  }

  console.warn("⚠️ Nenhum navegador compatível (Chrome/Edge) encontrado nos caminhos padrão.");
  return undefined;
}

const executablePath = getChromeExecutablePath();

// Helper to update bot status in Supabase table `whatsapp_config`
async function updateBotStatus(status: string, qrCode: string | null = null, phone: string | null = null) {
  try {
    const supabase = getSupabase();
    if (!supabase) return;

    const updateData: any = {
      id: 1,
      status,
      qr_code: qrCode,
      updated_at: new Date().toISOString()
    };

    if (phone) {
      updateData.phone = phone;
    }

    const { error } = await supabase
      .from("whatsapp_config")
      .upsert(updateData, { onConflict: "id" });

    if (error) {
      console.warn(`⚠️ [WhatsApp Bot] Não foi possível salvar status '${status}' no Supabase:`, error.message);
    } else {
      console.log(`🤖 [WhatsApp Bot] Status sincronizado no Supabase: ${status}`);
    }
  } catch (err: any) {
    console.warn(`⚠️ [WhatsApp Bot] Erro ao sincronizar status no Supabase:`, err.message || err);
  }
}

// 3. Initialize WhatsApp Client
console.log("⚡ Inicializando o cliente WhatsApp...");
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.resolve(process.cwd(), ".wwebjs_auth"),
  }),
  puppeteer: {
    executablePath: executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  },
});

// 4. Register Event Listeners
client.on("qr", (qr) => {
  console.log("\n=============================================================");
  console.log("📲 ESCANEIE O QR CODE ABAIXO COM SEU WHATSAPP:");
  console.log("=============================================================\n");
  qrcode.generate(qr, { small: true });
  console.log("\n=============================================================\n");
  updateBotStatus("qr_ready", qr);
});

client.on("authenticated", () => {
  console.log("✅ Conectado com sucesso ao WhatsApp!");
  updateBotStatus("connected");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Falha na autenticação do WhatsApp:", msg);
  updateBotStatus("disconnected");
});

client.on("ready", () => {
  console.log("🚀 Robô do WhatsApp está pronto e aguardando mensagens!");
  const botNumber = client.info?.wid?.user || null;
  updateBotStatus("connected", null, botNumber);
  startReminderLoop(client);
  startChatSyncLoop(client);
});

client.on("disconnected", (reason) => {
  console.log(`⚠️ WhatsApp desconectado: ${reason}`);
  updateBotStatus("disconnected");
});

// 5. Incoming message handler (inbound chat + auto-responder flow)
client.on("message", async (msg) => {
  try {
    const supabase = getSupabase();
    if (supabase) {
      const chat = await msg.getChat();
      const contact = await msg.getContact();
      const contactName = chat.name || contact.pushname || contact.name || "Cliente WhatsApp";
      
      const { error } = await supabase
        .from("whatsapp_messages")
        .insert({
          chat_jid: msg.from,
          contact_name: contactName,
          body: msg.body,
          from_me: false,
          status: "received",
          created_at: new Date().toISOString()
        });
        
      if (error) {
        console.warn("⚠️ [Chat Inbox] Erro ao salvar mensagem no Supabase:", error.message);
      } else {
        console.log(`📥 [Chat Inbox] Mensagem de ${contactName} recebida e salva.`);
      }
    }
  } catch (err: any) {
    console.warn("⚠️ [Chat Inbox] Falha ao processar mensagem recebida:", err.message || err);
  }

  // Auto-responder flow logic (check if chatbot responses are enabled in Supabase)
  try {
    const supabase = getSupabase();
    if (supabase) {
      const { data: config } = await supabase
        .from("whatsapp_config")
        .select("enable_responses")
        .eq("id", 1)
        .maybeSingle();

      if (config && config.enable_responses === false) {
        console.log("ℹ️ [Chatbot Flow] Auto-respostas (chatbot) desativadas nas configurações.");
      } else {
        await handleIncomingMessage(msg, client);
      }
    } else {
      await handleIncomingMessage(msg, client);
    }
  } catch (flowErr: any) {
    console.error("❌ [Chatbot Flow] Erro ao rodar fluxo para mensagem recebida:", flowErr.message || flowErr);
  }
});

// 6. Outgoing message mirroring (sent from mobile or bot replies)
client.on("message_create", async (msg) => {
  if (msg.fromMe) {
    try {
      const supabase = getSupabase();
      if (!supabase) return;

      // Prevent duplicating messages sent by dashboard client
      const fifteenSecondsAgo = new Date(Date.now() - 15000).toISOString();
      const { data: duplicate } = await supabase
        .from("whatsapp_messages")
        .select("id")
        .eq("chat_jid", msg.to)
        .eq("body", msg.body)
        .eq("from_me", true)
        .gte("created_at", fifteenSecondsAgo)
        .maybeSingle();

      if (duplicate) {
        return; // Already logged, exit!
      }

      const chat = await msg.getChat();
      await supabase
        .from("whatsapp_messages")
        .insert({
          chat_jid: msg.to,
          contact_name: chat.name || "Cliente WhatsApp",
          body: msg.body,
          from_me: true,
          status: "sent",
          created_at: new Date().toISOString()
        });
      console.log(`📤 [Chat Sync] Resposta pelo celular/bot sincronizada para ${msg.to}.`);
    } catch (err: any) {
      // Fail silently
    }
  }
});

// 7. Outbox synchronization (dashboard sending queue)
function startChatSyncLoop(client: Client) {
  console.log("⏳ [Chat Outbox] Loop de envio de mensagens ativado (checagem a cada 2.5 segundos).");
  
  setInterval(async () => {
    try {
      const supabase = getSupabase();
      if (!supabase) return;
      
      const { data: pendingMsgs, error } = await supabase
        .from("whatsapp_messages")
        .select("*")
        .eq("from_me", true)
        .eq("status", "pending")
        .order("created_at", { ascending: true });
        
      if (error) return;
      
      if (pendingMsgs && pendingMsgs.length > 0) {
        console.log(`💬 [Chat Outbox] Encontrada(s) ${pendingMsgs.length} mensagem(ns) pendente(s) para enviar.`);
        for (const msg of pendingMsgs) {
          try {
            await client.sendMessage(msg.chat_jid, msg.body);
            await supabase
              .from("whatsapp_messages")
              .update({ status: "sent" })
              .eq("id", msg.id);
            console.log(`✅ [Chat Outbox] Mensagem id ${msg.id} enviada.`);
          } catch (sendErr: any) {
            console.error(`❌ [Chat Outbox] Falha ao enviar mensagem ${msg.id}:`, sendErr.message || sendErr);
            await supabase
              .from("whatsapp_messages")
              .update({ status: "failed" })
              .eq("id", msg.id);
          }
        }
      }
    } catch (err) {
      // Loop safety
    }
  }, 2500);
}

// Start client
updateBotStatus("connecting");
client.initialize().catch((err) => {
  console.error("❌ Erro ao inicializar o cliente:", err);
  updateBotStatus("disconnected");
});

