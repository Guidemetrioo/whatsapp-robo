import { Client, LocalAuth } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
import readline from "readline";
import { getSupabase } from "./db";
import { checkAndSendReminders } from "./reminder";

// Helper to load .env.local
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
  }
}

loadEnv();

// Helper to get local time of a specific timezone represented as a UTC Date object
function getLocalAsUtc(date: Date, timeZone: string): Date {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23"
  });
  
  const parts = formatter.formatToParts(date);
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = parseInt(part.value, 10);
    }
  }
  return new Date(Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second));
}

// Detect Chromium/Edge
function getChromeExecutablePath(): string | undefined {
  if (process.platform === "win32") {
    const possiblePaths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    const possiblePaths = [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/brave-browser",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query: string): Promise<string> => {
  return new Promise((resolve) => rl.question(query, resolve));
};

async function main() {
  console.log("\n=============================================================");
  console.log("🧪 SCRIPT DE TESTE DE DISPARO DE LEMBRETES (AURA BARBER)");
  console.log("=============================================================\n");

  let mode = "";
  while (mode !== "1" && mode !== "2") {
    const input = await askQuestion(
      "Escolha o tipo de teste:\n" +
      "[1] Teste Rápido Mock (Envia um lembrete direto para o WhatsApp sem banco de dados)\n" +
      "[2] Teste Completo Supabase (Insere agendamento de teste no Supabase, roda verificação e limpa depois)\n" +
      "Opção [1 ou 2]: "
    );
    mode = input.trim();
    if (mode !== "1" && mode !== "2") {
      console.log("❌ Opção inválida. Por favor, digite 1 ou 2.\n");
    }
  }

  let cleanPhone = "";
  while (cleanPhone.length < 10) {
    const phoneInput = await askQuestion("Digite o celular/WhatsApp para receber o teste (com DDD, ex: 11999999999): ");
    cleanPhone = phoneInput.replace(/\D/g, "");
    if (cleanPhone.length < 10) {
      console.log("❌ Número de telefone inválido. Por favor, digite um número válido com DDD.\n");
    }
  }

  let testServiceKey = "";
  if (mode === "2") {
    const currentKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (!currentKey || currentKey.includes("placeholder")) {
      console.log("\n⚠️ A chave SUPABASE_SERVICE_ROLE_KEY em `.env.local` é um placeholder.");
      console.log("Para que o teste no banco funcione, precisamos de uma chave válida (Service Role ou Anon).");
      const keyInput = await askQuestion("Cole aqui a chave do Supabase (ou pressione Enter para tentar usar a Anon Key): ");
      if (keyInput.trim()) {
        process.env.SUPABASE_SERVICE_ROLE_KEY = keyInput.trim();
      } else {
        process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      }
    }
  }

  console.log("\n⚡ Inicializando WhatsApp Client...");
  const executablePath = getChromeExecutablePath();
  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.resolve(process.cwd(), ".wwebjs_auth"),
    }),
    puppeteer: {
      executablePath,
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

  client.on("qr", (qr) => {
    console.log("\n📲 ESCANEIE O QR CODE ABAIXO COM SEU WHATSAPP:");
    console.log("=============================================================\n");
    qrcode.generate(qr, { small: true });
    console.log("\n=============================================================\n");
  });

  client.on("authenticated", () => {
    console.log("✅ Conectado ao WhatsApp!");
  });

  client.on("auth_failure", (msg) => {
    console.error("❌ Falha na autenticação do WhatsApp:", msg);
  });

  client.on("ready", async () => {
    console.log("🚀 Cliente pronto! Iniciando teste...");

    try {
      if (mode === "1") {
        // Mode 1: Send mock reminder directly
        console.log("👉 Executando Teste Rápido Mock...");
        
        // Calculate a simulated time (30 minutes from now)
        const now = new Date();
        const testTime = new Date(now.getTime() + 30 * 60 * 1000);
        const hours = String(testTime.getHours()).padStart(2, "0");
        const minutes = String(testTime.getMinutes()).padStart(2, "0");
        const timeStr = `${hours}:${minutes}`;

        const messageText = `Olá, *Cliente Teste Aura*! Passando para lembrar que você tem um agendamento na *Aura Barber* em 30 minutos (às *${timeStr}h*).\n\n` +
          `💈 *Serviço:* Combo Corte + Barba (Teste)\n` +
          `✂️ *Profissional:* Barbeiro Teste\n\n` +
          `Confirmado? Te aguardamos! ☕`;

        let formattedPhone = cleanPhone;
        if (formattedPhone.length === 11 && !formattedPhone.startsWith("55")) {
          formattedPhone = "55" + formattedPhone;
        }
        if (!formattedPhone.endsWith("@c.us")) {
          formattedPhone = formattedPhone + "@c.us";
        }

        console.log(`📱 Enviando mensagem de teste para ${formattedPhone}...`);
        await client.sendMessage(formattedPhone, messageText);
        console.log("🎉 Lembrete enviado com sucesso via WhatsApp!");

      } else {
        // Mode 2: Insert into Supabase, run check, clean up
        console.log("👉 Executando Teste Completo com Supabase...");
        const supabase = getSupabase();

        // 1. Create a test professional
        console.log("➕ Inserindo profissional temporário...");
        const { data: prof, error: profErr } = await supabase
          .from("professionals")
          .insert({
            name: "Barbeiro Teste Automático",
            phone: "11999999999",
            specialties: ["Corte", "Barba"],
            commission_rate: 0.40
          })
          .select()
          .single();

        if (profErr || !prof) {
          throw new Error(`Erro ao criar profissional de teste: ${profErr?.message || "Sem retorno"}`);
        }
        console.log(`✅ Profissional criado: ID ${prof.id}`);

        // 2. Create a test service
        console.log("➕ Inserindo serviço temporário...");
        const { data: service, error: svcErr } = await supabase
          .from("services")
          .insert({
            name: "Serviço de Teste Bot",
            category: "Corte",
            price: 50.00,
            duration_minutes: 30
          })
          .select()
          .single();

        if (svcErr || !service) {
          // Cleanup prof
          await supabase.from("professionals").delete().eq("id", prof.id);
          throw new Error(`Erro ao criar serviço de teste: ${svcErr?.message || "Sem retorno"}`);
        }
        console.log(`✅ Serviço criado: ID ${service.id}`);

        // 3. Create a test client with user's phone number
        console.log("➕ Inserindo cliente temporário...");
        const { data: clientData, error: clientErr } = await supabase
          .from("clients")
          .insert({
            name: "Cliente Teste Remoto",
            phone: cleanPhone,
            email: "teste@aurabarber.com"
          })
          .select()
          .single();

        if (clientErr || !clientData) {
          // Cleanup
          await supabase.from("services").delete().eq("id", service.id);
          await supabase.from("professionals").delete().eq("id", prof.id);
          throw new Error(`Erro ao criar cliente de teste: ${clientErr?.message || "Sem retorno"}`);
        }
        console.log(`✅ Cliente criado: ID ${clientData.id}`);

        // 4. Ask which window to test
        let gapMinutes = 0;
        while (gapMinutes !== 10 && gapMinutes !== 30) {
          const gapInput = await askQuestion("Qual antecedência deseja simular para o agendamento? (Digite 30 ou 10): ");
          const parsed = parseInt(gapInput.trim(), 10);
          if (parsed === 10 || parsed === 30) {
            gapMinutes = parsed;
          } else {
            console.log("❌ Opção inválida. Por favor, digite 10 ou 30.\n");
          }
        }

        console.log(`➕ Inserindo agendamento para daqui a ${gapMinutes} minutos...`);
        
        // Match the reminder.ts time shift behavior
        const now = getLocalAsUtc(new Date(), "America/Sao_Paulo");
        const apptTimeISO = new Date(now.getTime() + gapMinutes * 60 * 1000).toISOString();

        const { data: appt, error: apptErr } = await supabase
          .from("appointments")
          .insert({
            client_id: clientData.id,
            professional_id: prof.id,
            datetime: apptTimeISO,
            status: "Agendado",
            services: [service.id],
            reminder_sent: false
          })
          .select()
          .single();

        if (apptErr || !appt) {
          // Cleanup
          await supabase.from("clients").delete().eq("id", clientData.id);
          await supabase.from("services").delete().eq("id", service.id);
          await supabase.from("professionals").delete().eq("id", prof.id);
          throw new Error(`Erro ao criar agendamento de teste: ${apptErr?.message || "Sem retorno"}`);
        }
        console.log(`✅ Agendamento de teste criado às ${apptTimeISO} (ID: ${appt.id})`);

        // 5. Run the checkAndSendReminders function!
        console.log("🔍 Acionando verificação do banco de dados...");
        await checkAndSendReminders(client);

        // Verify if reminder_sent has been updated to true
        const { data: updatedAppt } = await supabase
          .from("appointments")
          .select("reminder_sent")
          .eq("id", appt.id)
          .single();

        if (updatedAppt?.reminder_sent) {
          console.log("🎉 SUCESSO: O lembrete foi enviado e o registro foi atualizado com 'reminder_sent = true'!");
        } else {
          console.log("⚠️ ATENÇÃO: O lembrete pode não ter sido enviado ou não foi marcado como enviado.");
        }

        // 6. Cleanup
        console.log("🧹 Iniciando limpeza dos dados de teste...");
        await supabase.from("appointments").delete().eq("id", appt.id);
        await supabase.from("clients").delete().eq("id", clientData.id);
        await supabase.from("services").delete().eq("id", service.id);
        await supabase.from("professionals").delete().eq("id", prof.id);
        console.log("✅ Limpeza concluída!");
      }
    } catch (e: any) {
      console.error("❌ Ocorreu um erro durante a execução do teste:", e.message || e);
    } finally {
      console.log("\nEncerrando cliente e limpando conexões...");
      await client.destroy();
      rl.close();
    }
  });

  client.initialize().catch((err) => {
    console.error("❌ Erro ao inicializar o cliente WhatsApp:", err);
    rl.close();
  });
}

main();
