# WhatsApp Scheduling Bot

Este é um robô autônomo (chatbot) para WhatsApp criado para responder a mensagens recebidas, automatizar fluxos de agendamentos e enviar lembretes. Ele é integrado com o banco de dados Supabase da Barbearia.

## 🛠️ Tecnologias Utilizadas

- **Node.js** com **TypeScript**
- **whatsapp-web.js** (autenticação local via Puppeteer)
- **@supabase/supabase-js** (integração direta com o banco de dados)
- **tsx** (execução direta em TypeScript)

---

## 🚀 Como Executar

### 1. Requisitos
- Node.js instalado (v18 ou superior)
- Um banco de dados Supabase configurado com as tabelas `whatsapp_config` e `whatsapp_messages`

### 2. Configuração do `.env.local`
Crie um arquivo `.env.local` na raiz deste diretório (caso não exista) e configure suas variáveis de acesso ao Supabase:

```env
NEXT_PUBLIC_SUPABASE_URL=https://sua-url-supabase.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=seu-anon-key
```

### 3. Instalar Dependências
Instale os pacotes necessários:
```bash
npm install
```

### 4. Iniciar o Robô
Rode o robô em modo de desenvolvimento (com auto-reload ao modificar arquivos):
```bash
npm run dev
```

Ou em modo de produção:
```bash
npm start
```

---

## 📲 Conexão e Funcionamento
1. Ao iniciar o robô pela primeira vez, ele exibirá um **QR Code no terminal**.
2. Ele também atualizará o status no Supabase. Se o seu painel web estiver ativo, o QR Code aparecerá automaticamente na tela de **Configurações -> Integração WhatsApp**.
3. Escaneie o QR Code usando a opção **Aparelhos Conectados** no seu celular para autenticar.
4. O robô começará a ouvir novas mensagens, executar o fluxo de auto-agendamento e sincronizar as conversas no chat central.
