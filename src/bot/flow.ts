import { Message } from "whatsapp-web.js";
import { getSupabase } from "./db";

// ==========================================
// MOCK DATA FALLBACKS (Matches AuraContext.tsx)
// ==========================================
interface Service {
  id: number;
  name: string;
  price: number;
  duration_minutes: number;
}

interface Professional {
  id: number;
  name: string;
  specialties: string[];
}

interface Appointment {
  id: number;
  client_id: number;
  professional_id: number;
  datetime: string;
  status: string;
  services: number[];
}

interface Client {
  id: number;
  name: string;
  phone: string;
}

const mockServices: Service[] = [
  { id: 1, name: "Corte Degradê", price: 70.0, duration_minutes: 40 },
  { id: 2, name: "Corte Social", price: 60.0, duration_minutes: 30 },
  { id: 3, name: "Barba Premium", price: 55.0, duration_minutes: 30 },
  { id: 4, name: "Combo Corte + Barba", price: 110.0, duration_minutes: 70 },
  { id: 5, name: "Selagem Capilar", price: 120.0, duration_minutes: 60 },
  { id: 6, name: "Nevou / Platinado", price: 180.0, duration_minutes: 150 },
  { id: 7, name: "Pigmentação de Barba", price: 45.0, duration_minutes: 25 },
  { id: 8, name: "Sobrancelha na Navalha", price: 25.0, duration_minutes: 15 },
  { id: 9, name: "Barboterapia Completa", price: 80.0, duration_minutes: 45 },
  { id: 10, name: "Massagem Capilar", price: 40.0, duration_minutes: 20 },
];

const mockProfessionals: Professional[] = [
  { id: 1, name: "Barbeiro 1", specialties: ["Corte Degradê", "Nevou", "Desenhos/Hair Tattoo"] },
  { id: 2, name: "Barbeiro 2", specialties: ["Cortes Clássicos", "Selagem Capilar", "Barboterapia"] },
  { id: 3, name: "Barbeiro 3", specialties: ["Corte Social", "Barba Toalha Quente", "Sobrancelha"] },
];

// In-memory lists of appointments and clients for the bot session when Supabase is not active
const localAppointments: Appointment[] = [];
const localClients: Client[] = [
  { id: 1, name: "Bruno Souza", phone: "5511987654321" },
];

// ==========================================
// USER CHATBOT STATE MACHINE
// ==========================================
interface UserState {
  step:
    | "MENU"
    | "ASK_NAME"
    | "SELECT_SERVICE"
    | "SELECT_PROFESSIONAL"
    | "SELECT_DATE"
    | "SELECT_TIME"
    | "CONFIRM";
  name?: string;
  phone: string; // clean phone format
  serviceId?: number;
  professionalId?: number;
  date?: string; // DD/MM/YYYY or YYYY-MM-DD
  time?: string; // HH:MM
  availableTimes?: string[];
}

const userStates = new Map<string, UserState>();

// Helper to fetch services (with Supabase fallback)
async function getServices(): Promise<Service[]> {
  try {
    const { data, error } = await getSupabase().from("services").select("id, name, price, duration_minutes");
    if (error || !data || data.length === 0) throw new Error("Fallback required");
    return data;
  } catch {
    return mockServices;
  }
}

// Helper to fetch professionals (with Supabase fallback)
async function getProfessionals(): Promise<Professional[]> {
  try {
    const { data, error } = await getSupabase().from("professionals").select("id, name, specialties");
    if (error || !data || data.length === 0) throw new Error("Fallback required");
    return data;
  } catch {
    return mockProfessionals;
  }
}

// Helper to fetch appointments (with Supabase fallback)
async function getAppointments(): Promise<Appointment[]> {
  try {
    const { data, error } = await getSupabase().from("appointments").select("id, client_id, professional_id, datetime, status, services");
    if (error || !data) throw new Error("Fallback required");
    return data;
  } catch {
    return localAppointments;
  }
}

// Helper to find or create a client
async function getOrCreateClient(phone: string, name?: string): Promise<Client> {
  const cleanPhone = phone.replace(/\D/g, "");
  
  try {
    // 1. Check Supabase
    const { data, error } = await getSupabase()
      .from("clients")
      .select("id, name, phone")
      .eq("phone", cleanPhone)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;

    if (name) {
      const { data: newClient, error: insertError } = await getSupabase()
        .from("clients")
        .insert([{ name, phone: cleanPhone, email: `${name.toLowerCase().replace(/\s+/g, ".")}@whatsapp.com` }])
        .select()
        .single();
      
      if (insertError) throw insertError;
      return newClient;
    }
  } catch (err) {
    // Falls back to local array
    let client = localClients.find((c) => c.phone === cleanPhone);
    if (!client && name) {
      client = {
        id: localClients.length + 1,
        name,
        phone: cleanPhone,
      };
      localClients.push(client);
    }
    return client || { id: 999, name: name || "Cliente", phone: cleanPhone };
  }
  
  return { id: 999, name: "Cliente", phone: cleanPhone };
}

// Helper to insert an appointment
async function createAppointment(appt: Omit<Appointment, "id">) {
  try {
    const { error } = await getSupabase().from("appointments").insert([appt]);
    if (error) throw error;
    console.log("✅ Agendamento salvo no Supabase com sucesso.");
  } catch (err) {
    // Save locally
    const newId = localAppointments.length + 1;
    localAppointments.push({ id: newId, ...appt });
    console.log(`💾 Agendamento salvo em memória local (ID: ${newId}).`);
  }
}

// Generate timeslots available for a professional on a date
async function getAvailableTimes(dateStr: string, profId: number): Promise<string[]> {
  const baseSlots = [
    "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
    "12:00", "12:30", "13:00", "13:30", "14:00", "14:30",
    "15:00", "15:30", "16:00", "16:30", "17:00", "17:30",
    "18:00", "18:30",
  ];

  const appts = await getAppointments();
  
  // Filter appointments for this date and professional
  const bookedSlots = appts
    .filter((a) => {
      if (a.professional_id !== profId || a.status === "Cancelado") return false;
      const apptDate = new Date(a.datetime);
      
      // Format apptDate to match dateStr (DD/MM) (using UTC methods as local hour is stored in UTC)
      const day = String(apptDate.getUTCDate()).padStart(2, "0");
      const month = String(apptDate.getUTCMonth() + 1).padStart(2, "0");
      const formattedApptDate = `${day}/${month}`;
      
      return formattedApptDate === dateStr;
    })
    .map((a) => {
      const apptDate = new Date(a.datetime);
      const hours = String(apptDate.getUTCHours()).padStart(2, "0");
      const minutes = String(apptDate.getUTCMinutes()).padStart(2, "0");
      return `${hours}:${minutes}`;
    });

  return baseSlots.filter((slot) => !bookedSlots.includes(slot));
}

// Format date input to standardized DD/MM
function parseDateInput(text: string): string | null {
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);

  const cleanText = text.toLowerCase().trim();

  if (cleanText === "hoje") {
    return `${String(today.getDate()).padStart(2, "0")}/${String(today.getMonth() + 1).padStart(2, "0")}`;
  }
  if (cleanText === "amanhã" || cleanText === "amanha") {
    return `${String(tomorrow.getDate()).padStart(2, "0")}/${String(tomorrow.getMonth() + 1).padStart(2, "0")}`;
  }

  // Check pattern DD/MM or DD-MM
  const match = cleanText.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (match) {
    const day = String(parseInt(match[1])).padStart(2, "0");
    const month = String(parseInt(match[2])).padStart(2, "0");
    return `${day}/${month}`;
  }

  return null;
}

// Main message handler
export async function handleIncomingMessage(msg: Message, client: any) {
  const from = msg.from;
  const body = msg.body.trim();
  const cleanPhone = from.split("@")[0];

  // Retrieve user state or initialize
  let state = userStates.get(from);
  if (!state) {
    state = { step: "MENU", phone: cleanPhone };
    userStates.set(from, state);
  }

  // Handle command to start over
  if (body.toLowerCase() === "sair" || body.toLowerCase() === "cancelar" || body.toLowerCase() === "menu") {
    state.step = "MENU";
    userStates.set(from, state);
    await msg.reply(
      "Atendimento reiniciado. 💈\nComo posso te ajudar hoje? Digite o número correspondente:\n\n1️⃣ Agendar um horário\n2️⃣ Ver nossos serviços e preços\n3️⃣ Ver meus agendamentos\n4️⃣ Falar com um atendente"
    );
    return;
  }

  // State Machine logic
  switch (state.step) {
    case "MENU": {
      if (body === "1") {
        // Find if client exists
        const existingClient = await getOrCreateClient(cleanPhone);
        if (existingClient && existingClient.name && existingClient.name !== "Cliente") {
          state.name = existingClient.name;
          state.step = "SELECT_SERVICE";
          userStates.set(from, state);
          
          const servicesList = await getServices();
          let text = `Olá, ${existingClient.name}! Vamos agendar seu horário. ✂️\nEscolha o serviço digitando o número correspondente:\n\n`;
          servicesList.forEach((s, idx) => {
            text += `*${idx + 1}* - ${s.name} (R$ ${s.price.toFixed(2)})\n`;
          });
          await msg.reply(text);
        } else {
          state.step = "ASK_NAME";
          userStates.set(from, state);
          await msg.reply("Olá! Que bom te ver por aqui. Para começarmos, digite o seu *nome completo*:");
        }
      } else if (body === "2") {
        const servicesList = await getServices();
        let text = "💈 *Aura Barber - Nossos Serviços & Preços* 💈\n\n";
        servicesList.forEach((s) => {
          text += `• *${s.name}* - R$ ${s.price.toFixed(2)} (${s.duration_minutes} min)\n`;
        });
        text += "\nDigite *1* para iniciar um agendamento ou envie qualquer mensagem para voltar ao menu.";
        await msg.reply(text);
      } else if (body === "3") {
        const appts = await getAppointments();
        const clientData = await getOrCreateClient(cleanPhone);
        const userAppts = appts.filter((a) => a.client_id === clientData.id && a.status !== "Cancelado");

        if (userAppts.length === 0) {
          await msg.reply("Você não possui agendamentos ativos no momento. 📅\nDigite *1* para agendar ou *menu* para voltar.");
        } else {
          const profs = await getProfessionals();
          const svcs = await getServices();
          
          let text = "📅 *Seus Agendamentos Ativos:* \n\n";
          userAppts.forEach((a) => {
            const dateObj = new Date(a.datetime);
            const prof = profs.find((p) => p.id === a.professional_id);
            const svcNames = a.services.map((id) => svcs.find((s) => s.id === id)?.name).join(", ");
            
            // Using UTC methods since database stores local time directly in UTC
            const day = String(dateObj.getUTCDate()).padStart(2, "0");
            const month = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
            const hours = String(dateObj.getUTCHours()).padStart(2, "0");
            const minutes = String(dateObj.getUTCMinutes()).padStart(2, "0");
            
            text += `• *${day}/${month} às ${hours}:${minutes}h*\n  Serviço: ${svcNames}\n  Profissional: ${prof?.name || "Qualquer um"}\n\n`;
          });
          text += "Se precisar cancelar algum horário, por favor digite *4* para falar com um atendente.";
          await msg.reply(text);
        }
      } else if (body === "4") {
        await msg.reply(
          "Encaminhei sua solicitação para a nossa recepção! ☕\nUm de nossos colaboradores entrará em contato com você neste número em breve."
        );
      } else {
        await msg.reply(
          "Olá! Seja bem-vindo à Aura Barber. 💈\nComo posso te ajudar hoje? Digite o número correspondente:\n\n1️⃣ Agendar um horário\n2️⃣ Ver nossos serviços e preços\n3️⃣ Ver meus agendamentos\n4️⃣ Falar com um atendente"
        );
      }
      break;
    }

    case "ASK_NAME": {
      if (body.length < 3) {
        await msg.reply("Por favor, digite seu nome completo para prosseguir:");
        return;
      }
      state.name = body;
      state.step = "SELECT_SERVICE";
      userStates.set(from, state);

      const servicesList = await getServices();
      let text = `Prazer, *${body}*! 💈\nEscolha o serviço digitando o número correspondente:\n\n`;
      servicesList.forEach((s, idx) => {
        text += `*${idx + 1}* - ${s.name} (R$ ${s.price.toFixed(2)})\n`;
      });
      await msg.reply(text);
      break;
    }

    case "SELECT_SERVICE": {
      const servicesList = await getServices();
      const choiceIdx = parseInt(body) - 1;
      
      if (isNaN(choiceIdx) || choiceIdx < 0 || choiceIdx >= servicesList.length) {
        await msg.reply("Opção inválida. Digite apenas o número correspondente ao serviço desejado:");
        return;
      }

      state.serviceId = servicesList[choiceIdx].id;
      state.step = "SELECT_PROFESSIONAL";
      userStates.set(from, state);

      const profsList = await getProfessionals();
      let text = `Perfeito! Você selecionou: *${servicesList[choiceIdx].name}*.\n\nAgora escolha o profissional digitando o número correspondente:\n\n`;
      profsList.forEach((p, idx) => {
        text += `*${idx + 1}* - ${p.name} (${p.specialties.slice(0, 2).join(", ")})\n`;
      });
      await msg.reply(text);
      break;
    }

    case "SELECT_PROFESSIONAL": {
      const profsList = await getProfessionals();
      const choiceIdx = parseInt(body) - 1;

      if (isNaN(choiceIdx) || choiceIdx < 0 || choiceIdx >= profsList.length) {
        await msg.reply("Opção inválida. Digite o número correspondente ao profissional:");
        return;
      }

      state.professionalId = profsList[choiceIdx].id;
      state.step = "SELECT_DATE";
      userStates.set(from, state);

      await msg.reply(
        `Você escolheu *${profsList[choiceIdx].name}*.\n\nQual a data desejada?\nDigite no formato *DD/MM* (ex: 20/06) ou digite *hoje* ou *amanhã*:`
      );
      break;
    }

    case "SELECT_DATE": {
      const formattedDate = parseDateInput(body);

      if (!formattedDate) {
        await msg.reply("Formato de data inválido. Por favor, digite no formato *DD/MM* (ex: 20/06) ou responda *hoje* ou *amanhã*:");
        return;
      }

      state.date = formattedDate;
      
      // Calculate times available
      const times = await getAvailableTimes(formattedDate, state.professionalId!);
      
      if (times.length === 0) {
        await msg.reply(
          `Desculpe, não há horários disponíveis para este profissional em ${formattedDate}. 😔\nPor favor, digite outra data (DD/MM):`
        );
        return;
      }

      state.availableTimes = times;
      state.step = "SELECT_TIME";
      userStates.set(from, state);

      let text = `Horários disponíveis em *${formattedDate}*:\nEscolha o horário digitando o número correspondente:\n\n`;
      times.forEach((t, idx) => {
        text += `*${idx + 1}* - ${t}h\n`;
      });
      await msg.reply(text);
      break;
    }

    case "SELECT_TIME": {
      const times = state.availableTimes || [];
      const choiceIdx = parseInt(body) - 1;

      if (isNaN(choiceIdx) || choiceIdx < 0 || choiceIdx >= times.length) {
        await msg.reply("Opção inválida. Escolha um dos números listados:");
        return;
      }

      state.time = times[choiceIdx];
      state.step = "CONFIRM";
      userStates.set(from, state);

      const svcs = await getServices();
      const profs = await getProfessionals();
      const svc = svcs.find((s) => s.id === state.serviceId);
      const prof = profs.find((p) => p.id === state.professionalId);

      const text = `Confirme as informações do seu agendamento: 📄\n\n` +
        `👤 *Cliente:* ${state.name}\n` +
        `💈 *Serviço:* ${svc?.name}\n` +
        `✂️ *Profissional:* ${prof?.name}\n` +
        `📅 *Data:* ${state.date}\n` +
        `🕒 *Horário:* ${state.time}h\n\n` +
        `Para confirmar, responda *1* (Confirmar)\n` +
        `Para cancelar e voltar ao menu, responda *2* (Cancelar)`;
      await msg.reply(text);
      break;
    }

    case "CONFIRM": {
      if (body === "1" || body.toLowerCase() === "confirmar") {
        const clientData = await getOrCreateClient(cleanPhone, state.name);
        
        // Parse date and time to ISO String (using Date.UTC to store local hour in UTC, matching frontend)
        const currentYear = new Date().getFullYear();
        const [day, month] = state.date!.split("/");
        const [hour, minute] = state.time!.split(":");
        const apptDate = new Date(Date.UTC(currentYear, parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute)));

        // Create the appointment
        await createAppointment({
          client_id: clientData.id,
          professional_id: state.professionalId!,
          datetime: apptDate.toISOString(),
          status: "Agendado",
          services: [state.serviceId!],
        });

        await msg.reply(
          `🎉 *Agendamento Confirmado com Sucesso!* 🎉\n\nObrigado, ${state.name}! Seu horário foi reservado em nosso sistema. Esperamos você no dia ${state.date} às ${state.time}h.\n\nSe precisar cancelar ou remarcar, nos avise o quanto antes. Abraços! 💈`
        );
        
        // Reset state
        state.step = "MENU";
        userStates.set(from, state);
      } else {
        state.step = "MENU";
        userStates.set(from, state);
        await msg.reply("Agendamento cancelado. Voltamos ao menu principal. 💈\nDigite *1* para iniciar um novo agendamento.");
      }
      break;
    }
  }
}
