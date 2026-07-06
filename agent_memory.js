// ════════════════════════════════════════════════════════════════════════════
// AGENT MEMORY — GitHub-based persistent memory for all SBL agents
// Writes Markdown files to GitHub → syncs to Obsidian automatically
// ════════════════════════════════════════════════════════════════════════════
import fetch from 'node-fetch';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO  = process.env.MEMORY_REPO  || 'saybelfinancing-arch/sbl-agent-memory';
const GITHUB_API   = 'https://api.github.com';

// ── Read file from GitHub ─────────────────────────────────────────────────
async function githubRead(path) {
  try {
    const r = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${path}`, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    if (r.status === 404) return { content: '', sha: null };
    const d = await r.json();
    return {
      content: Buffer.from(d.content, 'base64').toString('utf-8'),
      sha: d.sha
    };
  } catch(e) {
    console.error(`Memory read error (${path}):`, e.message);
    return { content: '', sha: null };
  }
}

// ── Write file to GitHub ──────────────────────────────────────────────────
async function githubWrite(path, content, message) {
  try {
    const { sha } = await githubRead(path);
    const body = {
      message: message || `Memory update: ${path}`,
      content: Buffer.from(content, 'utf-8').toString('base64'),
    };
    if (sha) body.sha = sha; // update existing file
    const r = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.content) {
      console.log(`Memory saved: ${path}`);
      return true;
    }
    console.error(`Memory write failed (${path}):`, JSON.stringify(d).substring(0, 100));
    return false;
  } catch(e) {
    console.error(`Memory write error (${path}):`, e.message);
    return false;
  }
}

// ── Append entry to a markdown file ──────────────────────────────────────
async function appendMemory(agentName, fileName, entry) {
  const path = `${agentName}/${fileName}.md`;
  const { content } = await githubRead(path);
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);

  const newEntry = `\n---\n**${timestamp}**\n${entry}\n`;
  const updated = content + newEntry;

  return await githubWrite(path, updated, `${agentName}: memory update`);
}

// ── Read full memory file ─────────────────────────────────────────────────
async function readMemory(agentName, fileName) {
  const path = `${agentName}/${fileName}.md`;
  const { content } = await githubRead(path);
  return content;
}

// ── Overwrite a memory section ────────────────────────────────────────────
async function updateSection(agentName, fileName, sectionTitle, newContent) {
  const path = `${agentName}/${fileName}.md`;
  const { content } = await githubRead(path);
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);

  // Replace or add section
  const sectionRegex = new RegExp(`## ${sectionTitle}[\\s\\S]*?(?=## |$)`, 'g');
  const newSection = `## ${sectionTitle}\n_Updated: ${timestamp}_\n\n${newContent}\n\n`;

  let updated;
  if (content.includes(`## ${sectionTitle}`)) {
    updated = content.replace(sectionRegex, newSection);
  } else {
    updated = content + '\n' + newSection;
  }

  return await githubWrite(path, updated, `${agentName}: update ${sectionTitle}`);
}

// ════════════════════════════════════════════════════════════════════════════
// AGENT-SPECIFIC MEMORY HELPERS
// ════════════════════════════════════════════════════════════════════════════

// ── JANE memory ───────────────────────────────────────────────────────────
export const JaneMemory = {
  async saveInvoice(invoiceData) {
    const entry = `**Invoice ${invoiceData.number}**
- Client: ${invoiceData.client}
- Amount: ${invoiceData.currency}${invoiceData.total}
- Date: ${invoiceData.date}
- Type: ${invoiceData.taxMode === 'zero' ? 'RF (VAT 0%)' : 'Thai (VAT 7%)'}`;
    return await appendMemory('Jane', 'invoices', entry);
  },

  async saveClient(clientData) {
    const entry = `**${clientData.name}** (${clientData.code})
- Phone: ${clientData.phone}
- Address: ${clientData.address}
- Tax ID: ${clientData.taxId || '—'}`;
    return await appendMemory('Jane', 'clients', entry);
  },

  async getInvoiceHistory() {
    return await readMemory('Jane', 'invoices');
  },

  async saveSession(summary) {
    return await appendMemory('Jane', 'sessions', summary);
  }
};

// ── ALEXEY memory ─────────────────────────────────────────────────────────
export const AlexeyMemory = {
  async saveLead(lead) {
    const entry = `**${lead.company}**
- Contact: ${lead.contact || '—'}
- Phone: ${lead.phone || '—'}
- Status: ${lead.status}
- Notes: ${lead.notes || '—'}`;
    return await appendMemory('Alexey', 'leads', entry);
  },

  async updatePipeline(pipelineText) {
    return await updateSection('Alexey', 'pipeline', 'Active Pipeline', pipelineText);
  },

  async getLeads() {
    return await readMemory('Alexey', 'leads');
  }
};

// ── FELIX memory ──────────────────────────────────────────────────────────
export const FelixMemory = {
  async saveOrder(order) {
    const entry = `**Order #${order.num}** — ${order.customer}
- Items: ${order.items}
- Total: ${order.total}
- Status: ${order.status}`;
    return await appendMemory('Felix', 'orders', entry);
  },

  async saveCustomer(customer) {
    const entry = `**${customer.name}** (${customer.code})
- Phone: ${customer.phone}
- Preferences: ${customer.notes || '—'}`;
    return await appendMemory('Felix', 'customers', entry);
  }
};

// ── MAYA memory ───────────────────────────────────────────────────────────
export const MayaMemory = {
  async saveViralFormat(format) {
    const entry = `**${format.name}** (Score: ${format.score}/10)
- Product: ${format.product}
- Hook: ${format.hook}
- Why it works: ${format.reason}`;
    return await appendMemory('Maya', 'viral_formats', entry);
  },

  async saveContentIdea(idea) {
    return await appendMemory('Maya', 'content_ideas',
      `**${idea.title}**\n- Product: ${idea.product}\n- Format: ${idea.format}\n- Hook: ${idea.hook}`
    );
  },

  async getViralFormats() {
    return await readMemory('Maya', 'viral_formats');
  },

  async getNinaInsights() {
    return await readMemory('Nina', 'analytics_insights');
  }
};

// ── NINA memory ───────────────────────────────────────────────────────────
export const NinaMemory = {
  async saveWeeklyInsights(insights) {
    return await updateSection('Nina', 'analytics_insights', 'Latest Weekly Report', insights);
  },

  async saveViralPattern(pattern) {
    return await appendMemory('Nina', 'analytics_insights',
      `**Viral Pattern Detected**\n${pattern}`
    );
  }
};

// ── Generic memory for marketing agents ──────────────────────────────────
export const AgentMemory = {
  async save(agentName, fileName, entry) {
    return await appendMemory(agentName, fileName, entry);
  },
  async read(agentName, fileName) {
    return await readMemory(agentName, fileName);
  },
  async updateSection(agentName, fileName, section, content) {
    return await updateSection(agentName, fileName, section, content);
  }
};

export default {
  JaneMemory, AlexeyMemory, FelixMemory,
  MayaMemory, NinaMemory, AgentMemory
};
