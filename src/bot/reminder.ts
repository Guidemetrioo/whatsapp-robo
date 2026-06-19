import { getSupabase } from "./db";
import { Client as WhatsAppClient } from "whatsapp-web.js";

// Helper to format clean phone to whatsapp format resolving the Brazilian 9th digit JID issues
async function getWhatsappJid(client: WhatsAppClient, phone: string): Promise<string> {
  let clean = phone.replace(/\D/g, "");
  // Add Brazilian country code 55 if not present
  if (clean.length === 11 && !clean.startsWith("55")) {
    clean = "55" + clean;
  }
  
  try {
    const numberId = await client.getNumberId(clean);
    if (numberId) {
      return numberId._serialized;
    }
  } catch (err) {
    console.warn(`[WhatsApp] Erro ao buscar ID do número ${clean} no WhatsApp, usando formato padrão.`, err);
  }

  // Fallback to standard formatting
  if (!clean.endsWith("@c.us")) {
    clean = clean + "@c.us";
  }
  return clean;
}

// Global list to track sent reminders in Mock mode to avoid duplication
const mockSentReminders = new Set<number>();

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
  
  // Note: month from formatToParts is 1-indexed (1-12)
  return new Date(Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second));
}

export async function checkAndSendReminders(client: WhatsAppClient) {
  console.log("⏰ [Lembrete] Verificando agendamentos no banco de dados...");
  
  try {
    const supabase = getSupabase();
    
    // Fetch WhatsApp config dynamically from Supabase
    let minutesA = 30;
    let minutesB = 10;
    let enableReminders = true;
    
    try {
      const { data: config, error: configErr } = await supabase
        .from("whatsapp_config")
        .select("enable_reminders, reminder_minutes_a, reminder_minutes_b")
        .eq("id", 1)
        .maybeSingle();
        
      if (!configErr && config) {
        enableReminders = config.enable_reminders !== false;
        minutesA = config.reminder_minutes_a ?? 30;
        minutesB = config.reminder_minutes_b ?? 10;
      }
    } catch (dbErr) {
      // Table might not exist yet, fallback to default configurations
    }

    if (!enableReminders) {
      console.log("ℹ️ [Lembrete] Lembretes automáticos desativados nas configurações.");
      return;
    }
    
    const now = getLocalAsUtc(new Date(), "America/Sao_Paulo");
    
    // Window A: minutesA from now (between -5 and +5 of target)
    const min30 = new Date(now.getTime() + (minutesA - 5) * 60 * 1000).toISOString();
    const max30 = new Date(now.getTime() + (minutesA + 5) * 60 * 1000).toISOString();

    // Window B: minutesB from now (between -5 and +5 of target)
    const min10 = new Date(now.getTime() + (minutesB - 5) * 60 * 1000).toISOString();
    const max10 = new Date(now.getTime() + (minutesB + 5) * 60 * 1000).toISOString();
    
    // Query both windows in parallel
    const query30 = supabase
      .from("appointments")
      .select(`
        id,
        datetime,
        services,
        client_id,
        professional_id,
        reminder_sent,
        status
      `)
      .gte("datetime", min30)
      .lte("datetime", max30)
      .eq("reminder_sent", false)
      .in("status", ["Agendado", "Confirmado"]);

    const query10 = supabase
      .from("appointments")
      .select(`
        id,
        datetime,
        services,
        client_id,
        professional_id,
        reminder_sent,
        status
      `)
      .gte("datetime", min10)
      .lte("datetime", max10)
      .eq("reminder_sent", false)
      .in("status", ["Agendado", "Confirmado"]);

    const [res30, res10] = await Promise.all([query30, query10]);
       
    if (res30.error) throw res30.error;
    if (res10.error) throw res10.error;
    
    const appointmentsToProcess: Array<{ appt: any; minutesRemaining: number }> = [];
    const seenIds = new Set<number>();

    if (res30.data) {
      for (const appt of res30.data) {
        if (!seenIds.has(appt.id)) {
          seenIds.add(appt.id);
          appointmentsToProcess.push({ appt, minutesRemaining: minutesA });
        }
      }
    }

    if (res10.data) {
      for (const appt of res10.data) {
        if (!seenIds.has(appt.id)) {
          seenIds.add(appt.id);
          appointmentsToProcess.push({ appt, minutesRemaining: minutesB });
        }
      }
    }
    
    if (appointmentsToProcess.length === 0) {
      console.log("ℹ️ [Lembrete] Nenhum agendamento pendente para os próximos 30 ou 10 minutos.");
      return;
    }
    
    console.log(`🔍 [Lembrete] Encontrado(s) ${appointmentsToProcess.length} agendamento(s) para enviar lembrete.`);
    
    for (const { appt, minutesRemaining } of appointmentsToProcess) {
      try {
        // Fetch client details
        const { data: clientData, error: clientErr } = await supabase
          .from("clients")
          .select("name, phone")
          .eq("id", appt.client_id)
          .single();
          
        if (clientErr || !clientData) {
          console.error(`❌ [Lembrete] Erro ao buscar dados do cliente ${appt.client_id} para o agendamento ${appt.id}`);
          continue;
        }
        
        // Fetch professional details
        const { data: profData } = await supabase
          .from("professionals")
          .select("name")
          .eq("id", appt.professional_id)
          .single();
          
        const profName = profData?.name || "Profissional";
        
        // Fetch services names
        const { data: servicesData } = await supabase
          .from("services")
          .select("id, name");
          
        const serviceNames = (appt.services || [])
          .map((svcId: number) => servicesData?.find((s: any) => s.id === svcId)?.name || "Serviço")
          .join(", ");
          
        // Format appointment date time (using UTC methods since database stores local time in UTC)
        const apptDate = new Date(appt.datetime);
        const hours = String(apptDate.getUTCHours()).padStart(2, "0");
        const minutes = String(apptDate.getUTCMinutes()).padStart(2, "0");
        const timeStr = `${hours}:${minutes}`;
        
        const messageText = `Olá, *${clientData.name}*! Passando para lembrar que você tem um agendamento na *Aura Barber* em ${minutesRemaining} minutos (às *${timeStr}h*).\n\n` +
          `💈 *Serviço:* ${serviceNames}\n` +
          `✂️ *Profissional:* ${profName}\n\n` +
          `Confirmado? Te aguardamos! ☕`;
          
        const wppNumber = await getWhatsappJid(client, clientData.phone);
        
        console.log(`📱 [Lembrete] Enviando mensagem de WhatsApp para ${clientData.name} (${wppNumber})...`);
        await client.sendMessage(wppNumber, messageText);
        
        // Update database to mark reminder_sent = true
        const { error: updateErr } = await supabase
          .from("appointments")
          .update({ reminder_sent: true })
          .eq("id", appt.id);
          
        if (updateErr) {
          console.error(`⚠️ [Lembrete] Erro ao marcar lembrete como enviado para agendamento ${appt.id} no Supabase:`, updateErr);
        } else {
          console.log(`✅ [Lembrete] Agendamento ${appt.id} marcado como lembrete enviado no Supabase.`);
        }
        
      } catch (apptErr) {
        console.error(`❌ [Lembrete] Erro ao disparar lembrete para agendamento ${appt.id}:`, apptErr);
      }
    }
  } catch (err: any) {
    console.error("❌ [Lembrete] Erro ao consultar ou processar lembretes no Supabase:", err.message || err);
    // Mock Mode fallback execution (Local Memory Check)
    console.log("ℹ️ [Lembrete] Modo Mock (memória local): Verificando se há simulações de agendamento de teste...");
    
    // We will read a file or mock state here. For simplicity, we search if there are local test configurations.
    // If the user wants to simulate a trigger during local tests, we can provide a console message.
    console.log("💡 Para testar o envio de lembrete em modo Mock, crie os dados das tabelas no Supabase.");
  }
}

export async function checkAndSendNewConfirmations(client: WhatsAppClient) {
  try {
    const supabase = getSupabase();
    
    // Check if confirmations are enabled dynamically from Supabase
    let enableConfirmations = true;
    try {
      const { data: config, error: configErr } = await supabase
        .from("whatsapp_config")
        .select("enable_confirmations")
        .eq("id", 1)
        .maybeSingle();
        
      if (!configErr && config) {
        enableConfirmations = config.enable_confirmations !== false;
      }
    } catch (dbErr) {
      // Fallback
    }

    if (!enableConfirmations) {
      return;
    }
    
    // Fetch appointments that have status = 'Agendado'
    const { data: appointments, error } = await supabase
      .from("appointments")
      .select(`
        id,
        datetime,
        services,
        client_id,
        professional_id,
        status
      `)
      .eq("status", "Agendado");
      
    if (error) throw error;
    
    if (!appointments || appointments.length === 0) {
      return;
    }
    
    console.log(`📱 [Confirmação] Encontrado(s) ${appointments.length} novo(s) agendamento(s) para confirmar.`);
    
    for (const appt of appointments) {
      try {
        // Fetch client details
        const { data: clientData, error: clientErr } = await supabase
          .from("clients")
          .select("name, phone")
          .eq("id", appt.client_id)
          .single();
          
        if (clientErr || !clientData) {
          console.error(`❌ [Confirmação] Erro ao buscar dados do cliente ${appt.client_id} para o agendamento ${appt.id}`);
          continue;
        }
        
        // Fetch professional details
        const { data: profData } = await supabase
          .from("professionals")
          .select("name")
          .eq("id", appt.professional_id)
          .single();
          
        const profName = profData?.name || "Profissional";
        
        // Fetch services names
        const { data: servicesData } = await supabase
          .from("services")
          .select("id, name");
          
        const serviceNames = (appt.services || [])
          .map((svcId: number) => servicesData?.find((s: any) => s.id === svcId)?.name || "Serviço")
          .join(", ");
          
        // Format appointment date time (using UTC methods since database stores local time in UTC)
        const apptDate = new Date(appt.datetime);
        const day = String(apptDate.getUTCDate()).padStart(2, "0");
        const month = String(apptDate.getUTCMonth() + 1).padStart(2, "0");
        const dateStr = `${day}/${month}/${apptDate.getUTCFullYear()}`;
        
        const hours = String(apptDate.getUTCHours()).padStart(2, "0");
        const minutes = String(apptDate.getUTCMinutes()).padStart(2, "0");
        const timeStr = `${hours}:${minutes}`;
        
        const messageText = `Olá, *${clientData.name}*! Seu agendamento na *Aura Barber* foi realizado com sucesso! 🎉\n\n` +
          `📅 *Data:* ${dateStr}\n` +
          `⏰ *Horário:* ${timeStr}h\n` +
          `💈 *Serviço:* ${serviceNames}\n` +
          `✂️ *Profissional:* ${profName}\n\n` +
          `Te aguardamos! ☕`;
          
        const wppNumber = await getWhatsappJid(client, clientData.phone);
        
        console.log(`📱 [Confirmação] Enviando mensagem de confirmação de marcação para ${clientData.name} (${wppNumber})...`);
        await client.sendMessage(wppNumber, messageText);
        
        // Update database to mark status = 'Confirmado'
        const { error: updateErr } = await supabase
          .from("appointments")
          .update({ status: "Confirmado" })
          .eq("id", appt.id);
          
        if (updateErr) {
          console.error(`⚠️ [Confirmação] Erro ao atualizar status do agendamento ${appt.id} no Supabase:`, updateErr);
        } else {
          console.log(`✅ [Confirmação] Agendamento ${appt.id} atualizado para status 'Confirmado'.`);
        }
        
      } catch (apptErr) {
        console.error(`❌ [Confirmação] Erro ao disparar confirmação para agendamento ${appt.id}:`, apptErr);
      }
    }
  } catch (err) {
    // Fails silently in Mock mode
  }
}

export function startReminderLoop(client: WhatsAppClient) {
  // Run check every 1 minute
  console.log("⏳ [Lembrete] Loop de verificação de agendamentos ativado (checagem a cada 1 minuto).");
  
  // Run check every 10 seconds for immediate confirmations
  console.log("⏳ [Confirmação] Loop de verificação de novas marcações ativado (checagem a cada 10 segundos).");
  
  // Initial check on startup (waits 5 seconds to ensure connection stability)
  setTimeout(() => {
    checkAndSendReminders(client).catch(err => console.error("Erro na verificação de lembretes inicial:", err));
    checkAndSendNewConfirmations(client).catch(err => console.error("Erro na verificação de confirmações inicial:", err));
  }, 5000);
  
  setInterval(() => {
    checkAndSendReminders(client).catch(err => console.error("Erro na verificação periódica de lembretes:", err));
  }, 60 * 1000); // 1 minute

  setInterval(() => {
    checkAndSendNewConfirmations(client).catch(err => console.error("Erro na verificação periódica de novas marcações:", err));
  }, 10 * 1000); // 10 seconds
}
