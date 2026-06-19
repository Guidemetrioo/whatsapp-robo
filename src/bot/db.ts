import { createClient } from "@supabase/supabase-js";

let supabaseInstance: any = null;

export function getSupabase() {
  if (!supabaseInstance) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://your-project.supabase.co";
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
    
    if (!supabaseServiceKey || supabaseServiceKey.includes("placeholder") || supabaseUrl.includes("your-project")) {
      console.log("ℹ️ Supabase não configurado ou contendo credenciais padrão. Rodando no modo local (Mock).");
      // Return a dummy object that will cause queries to throw/fail gracefully, triggering fallback logic
      supabaseInstance = {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: new Error("Mock mode") })
            })
          }),
          insert: () => Promise.resolve({ error: new Error("Mock mode") }),
          update: () => ({
            eq: () => Promise.resolve({ error: new Error("Mock mode") })
          })
        })
      };
    } else {
      supabaseInstance = createClient(supabaseUrl, supabaseServiceKey);
    }
  }
  return supabaseInstance;
}
