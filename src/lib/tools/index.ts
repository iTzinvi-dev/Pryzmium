import crypto from 'crypto';
import { FunctionDeclaration, GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';

export type RiskLevel = 'read' | 'write' | 'destructive';
export type ConnectorId =
  | 'system'
  | 'search'
  | 'maps'
  | 'notes'
  | 'gmail'
  | 'calendar'
  | 'drive'
  | 'docs'
  | 'tasks';

export interface ToolExecutionContext {
  uid: string;
  googleAccessToken?: string | null;
  connectedProviders: ConnectorId[];
}

export interface ToolExecutionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  auditSummary: string;
  sensitiveDataRead?: boolean;
}

export interface AgentTool {
  name: string;
  connector: ConnectorId;
  description: string;
  risk: RiskLevel;
  requiredScopes: string[];
  zodSchema: z.ZodType<Record<string, unknown>>;
  declaration: FunctionDeclaration;
  summarizeArgs(args: Record<string, unknown>): string;
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
}

interface WorkspaceNoteItem {
  id: string;
  title: string;
  content: string;
  tag: string;
  updatedAt: string;
}

const userNotesVault = new Map<string, WorkspaceNoteItem[]>();

function getOrSeedUserNotes(uid: string): WorkspaceNoteItem[] {
  let list = userNotesVault.get(uid);
  if (!list) {
    list = [
      {
        id: 'note_arch_01',
        title: 'AI Agent Security Checklist',
        content:
          'Verify server-enforced SHA-256 argsHash on all write actions, keep Gmail read limit at 20 messages max, and isolate untrusted tool outputs.',
        tag: 'security',
        updatedAt: new Date().toISOString()
      },
      {
        id: 'note_prod_02',
        title: 'Weekly Sprint Priorities',
        content:
          'Finalize Google Docs, Google Tasks, Google Maps grounding, and Google Search grounding connectors in Vektor Workspace.',
        tag: 'roadmap',
        updatedAt: new Date().toISOString()
      }
    ];
    userNotesVault.set(uid, list);
  }
  return list;
}

let groundingAiClient: GoogleGenAI | null = null;
function getGroundingAi(): GoogleGenAI {
  if (!groundingAiClient) {
    groundingAiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });
  }
  return groundingAiClient;
}

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function stripHtmlAndTrim(raw: string, maxChars = 2200): string {
  const withoutScripts = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (withoutScripts.length <= maxChars) {
    return withoutScripts;
  }
  return `${withoutScripts.slice(0, maxChars)}… [trimmed for context safety]`;
}

function extractGmailBody(payload: Record<string, unknown> | undefined): string {
  if (!payload) return '';
  const bodyObj = payload.body as { data?: string } | undefined;
  if (bodyObj?.data) {
    return stripHtmlAndTrim(decodeBase64Url(bodyObj.data));
  }
  const parts = payload.parts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part.mimeType === 'text/plain') {
        const partBody = part.body as { data?: string } | undefined;
        if (partBody?.data) {
          return stripHtmlAndTrim(decodeBase64Url(partBody.data));
        }
      }
    }
    for (const part of parts) {
      const nested = extractGmailBody(part);
      if (nested) return nested;
    }
  }
  return '';
}

function extractGoogleDocText(bodyContent: Array<Record<string, unknown>> | undefined): string {
  if (!Array.isArray(bodyContent)) return '';
  const chunks: string[] = [];
  for (const structuralElement of bodyContent) {
    const paragraph = structuralElement.paragraph as
      | { elements?: Array<{ textRun?: { content?: string } }> }
      | undefined;
    if (paragraph?.elements) {
      for (const el of paragraph.elements) {
        if (el.textRun?.content) {
          chunks.push(el.textRun.content);
        }
      }
    }
  }
  return stripHtmlAndTrim(chunks.join(''), 2500);
}

function getHeader(headers: Array<{ name?: string; value?: string }> | undefined, target: string): string {
  if (!Array.isArray(headers)) return '';
  const match = headers.find((h) => h.name?.toLowerCase() === target.toLowerCase());
  return match?.value || '';
}

export const ALL_TOOLS: AgentTool[] = [
  {
    name: 'get_current_time',
    connector: 'system',
    description: 'Returns the current ISO timestamp, UTC time, and formatted date for scheduling or time-aware queries.',
    risk: 'read',
    requiredScopes: [],
    zodSchema: z.object({
      timezone: z.string().max(64).optional()
    }),
    declaration: {
      name: 'get_current_time',
      description: 'Get the current date and time in UTC and optional IANA timezone.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          timezone: {
            type: Type.STRING,
            description: 'Optional IANA timezone name such as America/New_York or Asia/Dhaka.'
          }
        }
      }
    },
    summarizeArgs: (args) => `timezone=${String(args.timezone || 'UTC')}`,
    execute: async (args) => {
      const now = new Date();
      const tz = typeof args.timezone === 'string' && args.timezone.trim() ? args.timezone.trim() : 'UTC';
      let formatted = now.toUTCString();
      try {
        formatted = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          dateStyle: 'full',
          timeStyle: 'long'
        }).format(now);
      } catch {
        formatted = now.toUTCString();
      }
      return {
        ok: true,
        data: {
          iso: now.toISOString(),
          timezone: tz,
          formatted
        },
        auditSummary: `Checked system clock (${tz})`
      };
    }
  },
  {
    name: 'web_fetch_summary',
    connector: 'system',
    description: 'Fetches a public HTTPS web page and extracts a trimmed plain-text excerpt (max 2200 characters).',
    risk: 'read',
    requiredScopes: [],
    zodSchema: z.object({
      url: z.string().url().max(500)
    }),
    declaration: {
      name: 'web_fetch_summary',
      description: 'Fetch and extract clean text from a public HTTPS webpage URL.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          url: {
            type: Type.STRING,
            description: 'Full https:// URL to inspect.'
          }
        },
        required: ['url']
      }
    },
    summarizeArgs: (args) => `url=${String(args.url || '').slice(0, 80)}`,
    execute: async (args) => {
      const rawUrl = String(args.url || '');
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawUrl);
      } catch {
        return {
          ok: false,
          error: 'Invalid URL format.',
          auditSummary: 'Blocked malformed URL'
        };
      }

      if (parsedUrl.protocol !== 'https:') {
        return {
          ok: false,
          error: 'Only HTTPS URLs are allowed by the security guardrail.',
          auditSummary: 'Blocked non-HTTPS web fetch'
        };
      }

      if (parsedUrl.port && parsedUrl.port !== '443') {
        return {
          ok: false,
          error: 'Non-standard HTTPS ports are blocked by the SSRF guardrail.',
          auditSummary: 'Blocked non-443 port fetch'
        };
      }

      const host = parsedUrl.hostname.toLowerCase();
      const isPrivateOrLocal =
        host === 'localhost' ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        host === '0.0.0.0' ||
        host === '127.0.0.1' ||
        host === '[::1]' ||
        host === '169.254.169.254' ||
        host === 'metadata.google.internal' ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^169\.254\./.test(host) ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host);

      if (isPrivateOrLocal) {
        return {
          ok: false,
          error: 'SSRF protection blocked access to private, loopback, or metadata hosts.',
          auditSummary: 'Blocked SSRF target host'
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(parsedUrl.toString(), {
          signal: controller.signal,
          redirect: 'error',
          headers: { 'User-Agent': 'VektorAgentSafeFetch/1.0' }
        });
        if (!res.ok) {
          return {
            ok: false,
            error: `HTTP ${res.status} when fetching URL.`,
            auditSummary: `Web fetch HTTP ${res.status} (${parsedUrl.hostname})`
          };
        }
        const text = await res.text();
        const excerpt = stripHtmlAndTrim(text, 2200);
        return {
          ok: true,
          data: {
            url: parsedUrl.toString(),
            status: res.status,
            excerpt
          },
          auditSummary: `Fetched public page (${parsedUrl.hostname}, ${excerpt.length} chars)`
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Unable to fetch webpage.',
          auditSummary: 'Web fetch failed'
        };
      } finally {
        clearTimeout(timer);
      }
    }
  },
  {
    name: 'google_search_grounding',
    connector: 'search',
    description: 'Executes a live Google Search using Gemini Search Grounding and returns verified facts along with source URLs.',
    risk: 'read',
    requiredScopes: [],
    zodSchema: z.object({
      query: z.string().min(2).max(300)
    }),
    declaration: {
      name: 'google_search_grounding',
      description: 'Search the live web using Google Search grounding for recent events, facts, or documentation.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'Search query to look up on Google Search.'
          }
        },
        required: ['query']
      }
    },
    summarizeArgs: (args) => `query="${String(args.query || '').slice(0, 60)}"`,
    execute: async (args) => {
      const q = String(args.query || '');
      try {
        const ai = getGroundingAi();
        let response;
        try {
          response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: q,
            config: {
              tools: [{ googleSearch: {} }]
            }
          });
        } catch {
          response = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: q,
            config: {
              tools: [{ googleSearch: {} }]
            }
          });
        }

        const rawChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        const sources: Array<{ title: string; uri: string }> = [];
        for (const chunk of rawChunks) {
          const web = (chunk as { web?: { uri?: string; title?: string } }).web;
          if (web?.uri) {
            sources.push({
              title: web.title || web.uri,
              uri: web.uri
            });
          }
        }

        return {
          ok: true,
          data: {
            query: q,
            answer: (response.text || '').slice(0, 2200),
            sources: sources.slice(0, 8)
          },
          auditSummary: `Google Search grounding ("${q.slice(0, 40)}", ${sources.length} sources)`
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Google Search grounding failed.',
          auditSummary: 'Google Search grounding error'
        };
      }
    }
  },
  {
    name: 'google_maps_grounding',
    connector: 'maps',
    description: 'Searches real-world places, restaurants, addresses, or geographic POIs using Google Maps Grounding and returns place details and official Google Maps URLs.',
    risk: 'read',
    requiredScopes: [],
    zodSchema: z.object({
      query: z.string().min(2).max(300),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional()
    }),
    declaration: {
      name: 'google_maps_grounding',
      description: 'Search places, local businesses, addresses, or points of interest using Google Maps Grounding. Always include the returned Maps URLs in your final answer.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'Place or location query (e.g., "Specialty coffee shops in Tokyo" or "Museums near Golden Gate Park").'
          },
          latitude: {
            type: Type.NUMBER,
            description: 'Optional latitude coordinate for proximity bias.'
          },
          longitude: {
            type: Type.NUMBER,
            description: 'Optional longitude coordinate for proximity bias.'
          }
        },
        required: ['query']
      }
    },
    summarizeArgs: (args) => `query="${String(args.query || '').slice(0, 60)}"`,
    execute: async (args) => {
      const q = String(args.query || '');
      const lat = typeof args.latitude === 'number' ? args.latitude : undefined;
      const lng = typeof args.longitude === 'number' ? args.longitude : undefined;

      try {
        const ai = getGroundingAi();
        const mapsConfig = {
          tools: [{ googleMaps: {} }],
          ...(lat !== undefined && lng !== undefined
            ? {
                toolConfig: {
                  retrievalConfig: {
                    latLng: {
                      latitude: lat,
                      longitude: lng
                    }
                  }
                }
              }
            : {})
        };
        let response;
        try {
          response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: q,
            config: mapsConfig
          });
        } catch {
          response = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: q,
            config: mapsConfig
          });
        }

        const rawChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        const places: Array<{ title: string; uri: string; reviewSnippets?: string[] }> = [];

        for (const chunk of rawChunks) {
          const mapsData = (
            chunk as {
              maps?: {
                uri?: string;
                title?: string;
                placeAnswerSources?: { reviewSnippets?: Array<{ content?: string }> };
              };
            }
          ).maps;

          if (mapsData?.uri) {
            const snippets =
              mapsData.placeAnswerSources?.reviewSnippets
                ?.map((s) => s.content || '')
                .filter(Boolean) || [];
            places.push({
              title: mapsData.title || 'Google Maps Place',
              uri: mapsData.uri,
              ...(snippets.length > 0 ? { reviewSnippets: snippets.slice(0, 2) } : {})
            });
          }
        }

        return {
          ok: true,
          data: {
            query: q,
            summary: (response.text || '').slice(0, 2200),
            places: places.slice(0, 8),
            complianceNotice: 'Include the place URLs from places[].uri as clickable links in your response.'
          },
          auditSummary: `Google Maps grounding ("${q.slice(0, 40)}", ${places.length} places)`
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Google Maps grounding failed.',
          auditSummary: 'Google Maps grounding error'
        };
      }
    }
  },
  {
    name: 'notes_list',
    connector: 'notes',
    description: 'Lists all saved notes in the user Workspace Notes vault.',
    risk: 'read',
    requiredScopes: [],
    zodSchema: z.object({
      tagFilter: z.string().max(40).optional()
    }),
    declaration: {
      name: 'notes_list',
      description: 'List saved notes from the user Workspace Notes connector.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          tagFilter: {
            type: Type.STRING,
            description: 'Optional tag keyword to filter notes.'
          }
        }
      }
    },
    summarizeArgs: (args) => `tagFilter="${String(args.tagFilter || 'all')}"`,
    execute: async (args, ctx) => {
      const notes = getOrSeedUserNotes(ctx.uid);
      const tag = typeof args.tagFilter === 'string' ? args.tagFilter.trim().toLowerCase() : '';
      const filtered = tag ? notes.filter((n) => n.tag.toLowerCase().includes(tag)) : notes;
      return {
        ok: true,
        data: {
          count: filtered.length,
          notes: filtered
        },
        auditSummary: `Listed ${filtered.length} Workspace Notes`
      };
    }
  },
  {
    name: 'notes_create',
    connector: 'notes',
    description: 'Creates a new persistent note in the user Workspace Notes vault. Write action requiring confirmation.',
    risk: 'write',
    requiredScopes: [],
    zodSchema: z.object({
      title: z.string().min(1).max(160),
      content: z.string().min(1).max(4000),
      tag: z.string().max(40).optional()
    }),
    declaration: {
      name: 'notes_create',
      description: 'Create a new note in Workspace Notes. Pauses for user confirmation.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description: 'Note title.'
          },
          content: {
            type: Type.STRING,
            description: 'Note body content.'
          },
          tag: {
            type: Type.STRING,
            description: 'Optional tag label (e.g., "work", "ideas", "research").'
          }
        },
        required: ['title', 'content']
      }
    },
    summarizeArgs: (args) => `title="${String(args.title || '').slice(0, 40)}"`,
    execute: async (args, ctx) => {
      const notes = getOrSeedUserNotes(ctx.uid);
      const newNote: WorkspaceNoteItem = {
        id: `note_${crypto.randomBytes(4).toString('hex')}`,
        title: String(args.title),
        content: String(args.content),
        tag: args.tag ? String(args.tag) : 'general',
        updatedAt: new Date().toISOString()
      };
      notes.unshift(newNote);
      return {
        ok: true,
        data: {
          note: newNote,
          status: 'note_created'
        },
        auditSummary: `Created Workspace Note "${newNote.title.slice(0, 40)}"`
      };
    }
  },
  {
    name: 'notes_delete',
    connector: 'notes',
    description: 'Deletes a note by ID from the user Workspace Notes vault. Destructive action requiring confirmation.',
    risk: 'destructive',
    requiredScopes: [],
    zodSchema: z.object({
      noteId: z.string().min(1).max(64)
    }),
    declaration: {
      name: 'notes_delete',
      description: 'Delete a note by noteId from Workspace Notes. Requires hard user confirmation.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          noteId: {
            type: Type.STRING,
            description: 'ID of the note to delete.'
          }
        },
        required: ['noteId']
      }
    },
    summarizeArgs: (args) => `noteId=${String(args.noteId || '')}`,
    execute: async (args, ctx) => {
      const notes = getOrSeedUserNotes(ctx.uid);
      const targetId = String(args.noteId);
      const idx = notes.findIndex((n) => n.id === targetId);
      if (idx === -1) {
        return {
          ok: false,
          error: `Note "${targetId}" not found.`,
          auditSummary: `Failed to delete note ${targetId} (not found)`
        };
      }
      const [removed] = notes.splice(idx, 1);
      return {
        ok: true,
        data: {
          deletedNoteId: targetId,
          title: removed.title
        },
        auditSummary: `Deleted Workspace Note "${removed.title.slice(0, 40)}"`
      };
    }
  },
  {
    name: 'docs_read_document',
    connector: 'docs',
    description: 'Reads a Google Docs document by documentId and extracts a trimmed plain-text summary.',
    risk: 'read',
    requiredScopes: ['https://www.googleapis.com/auth/documents'],
    zodSchema: z.object({
      documentId: z.string().min(5).max(160)
    }),
    declaration: {
      name: 'docs_read_document',
      description: 'Read the title and plain-text content of a Google Doc by its documentId (you can find documentIds using drive_search_files).',
      parameters: {
        type: Type.OBJECT,
        properties: {
          documentId: {
            type: Type.STRING,
            description: 'The Google Docs documentId.'
          }
        },
        required: ['documentId']
      }
    },
    summarizeArgs: (args) => `documentId=${String(args.documentId || '').slice(0, 24)}`,
    execute: async (args, ctx) => {
      if (!ctx.googleAccessToken) {
        return {
          ok: false,
          error: 'Google Docs is not connected. Please authorize Google Workspace in Connections.',
          auditSummary: 'Google Docs read failed (missing token)'
        };
      }
      const docId = String(args.documentId);
      const res = await fetch(
        `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`,
        {
          headers: { Authorization: `Bearer ${ctx.googleAccessToken}` }
        }
      );

      if (!res.ok) {
        return {
          ok: false,
          error: `Google Docs API returned HTTP ${res.status}.`,
          auditSummary: `Google Docs read HTTP ${res.status}`
        };
      }

      const data = (await res.json()) as {
        documentId?: string;
        title?: string;
        body?: { content?: Array<Record<string, unknown>> };
      };

      const textExcerpt = extractGoogleDocText(data.body?.content);

      return {
        ok: true,
        data: {
          documentId: data.documentId || docId,
          title: data.title || '(Untitled Document)',
          textExcerpt,
          url: `https://docs.google.com/document/d/${data.documentId || docId}/edit`
        },
        auditSummary: `Read Google Doc "${(data.title || docId).slice(0, 40)}"`,
        sensitiveDataRead: true
      };
    }
  },
  {
    name: 'docs_create_document',
    connector: 'docs',
    description: 'Creates a new Google Docs document with a title and initial content. Write action requiring confirmation.',
    risk: 'write',
    requiredScopes: ['https://www.googleapis.com/auth/documents'],
    zodSchema: z.object({
      title: z.string().min(1).max(200),
      initialContent: z.string().max(6000).optional()
    }),
    declaration: {
      name: 'docs_create_document',
      description: 'Create a new Google Docs document with a title and optional body text. Pauses for user confirmation.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description: 'Title of the new Google Doc.'
          },
          initialContent: {
            type: Type.STRING,
            description: 'Optional plain-text content to insert into the document body.'
          }
        },
        required: ['title']
      }
    },
    summarizeArgs: (args) => `title="${String(args.title || '').slice(0, 40)}"`,
    execute: async (args, ctx) => {
      if (!ctx.googleAccessToken) {
        return {
          ok: false,
          error: 'Google Docs access token unavailable. Please reconnect in Connections.',
          auditSummary: 'Create Google Doc failed (missing token)'
        };
      }
      const title = String(args.title);
      const initialContent = args.initialContent ? String(args.initialContent) : '';

      const createRes = await fetch('https://docs.googleapis.com/v1/documents', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.googleAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ title })
      });

      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => '');
        return {
          ok: false,
          error: `Google Docs API HTTP ${createRes.status}: ${errText.slice(0, 140)}`,
          auditSummary: 'Failed to create Google Doc'
        };
      }

      const created = (await createRes.json()) as { documentId?: string; title?: string };
      const docId = created.documentId;

      if (docId && initialContent.trim()) {
        await fetch(
          `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${ctx.googleAccessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              requests: [
                {
                  insertText: {
                    location: { index: 1 },
                    text: initialContent
                  }
                }
              ]
            })
          }
        );
      }

      return {
        ok: true,
        data: {
          documentId: docId,
          title: created.title || title,
          url: docId ? `https://docs.google.com/document/d/${docId}/edit` : '',
          status: 'document_created'
        },
        auditSummary: `Created Google Doc "${title.slice(0, 40)}"`
      };
    }
  },
  {
    name: 'tasks_list_items',
    connector: 'tasks',
    description: 'Lists tasks from the user default Google Tasks list.',
    risk: 'read',
    requiredScopes: ['https://www.googleapis.com/auth/tasks'],
    zodSchema: z.object({
      maxResults: z.number().int().min(1).max(20).optional(),
      showCompleted: z.boolean().optional()
    }),
    declaration: {
      name: 'tasks_list_items',
      description: 'List to-do items from the user primary Google Tasks list.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          maxResults: {
            type: Type.NUMBER,
            description: 'Maximum tasks to return (1 to 20, default 10).'
          },
          showCompleted: {
            type: Type.BOOLEAN,
            description: 'Whether to include completed tasks (default true).'
          }
        }
      }
    },
    summarizeArgs: (args) => `maxResults=${Number(args.maxResults || 10)}`,
    execute: async (args, ctx) => {
      if (!ctx.googleAccessToken) {
        return {
          ok: false,
          error: 'Google Tasks is not connected. Please authorize Google Workspace in Connections.',
          auditSummary: 'Google Tasks list failed (missing token)'
        };
      }
      const maxResults = Math.min(20, Math.max(1, Number(args.maxResults || 10)));
      const showCompleted = args.showCompleted !== false;
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        showCompleted: String(showCompleted)
      });

      const res = await fetch(
        `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${ctx.googleAccessToken}` }
        }
      );

      if (!res.ok) {
        return {
          ok: false,
          error: `Google Tasks API returned HTTP ${res.status}.`,
          auditSummary: `Google Tasks list HTTP ${res.status}`
        };
      }

      const data = (await res.json()) as {
        items?: Array<{
          id?: string;
          title?: string;
          notes?: string;
          status?: string;
          due?: string;
        }>;
      };

      const tasks = (data.items || []).map((t) => ({
        id: t.id || '',
        title: t.title || '(Untitled Task)',
        notes: (t.notes || '').slice(0, 300),
        status: t.status || 'needsAction',
        due: t.due || ''
      }));

      return {
        ok: true,
        data: {
          count: tasks.length,
          tasks
        },
        auditSummary: `Listed ${tasks.length} Google Tasks`,
        sensitiveDataRead: true
      };
    }
  },
  {
    name: 'tasks_create_item',
    connector: 'tasks',
    description: 'Creates a new task on the user primary Google Tasks list. Write action requiring confirmation.',
    risk: 'write',
    requiredScopes: ['https://www.googleapis.com/auth/tasks'],
    zodSchema: z.object({
      title: z.string().min(1).max(200),
      notes: z.string().max(1000).optional(),
      dueIso: z.string().max(64).optional()
    }),
    declaration: {
      name: 'tasks_create_item',
      description: 'Create a new to-do task in Google Tasks. Pauses for user confirmation.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description: 'Task title.'
          },
          notes: {
            type: Type.STRING,
            description: 'Optional notes or details for the task.'
          },
          dueIso: {
            type: Type.STRING,
            description: 'Optional RFC 3339 due timestamp (e.g., 2026-10-28T00:00:00.000Z).'
          }
        },
        required: ['title']
      }
    },
    summarizeArgs: (args) => `title="${String(args.title || '').slice(0, 40)}"`,
    execute: async (args, ctx) => {
      if (!ctx.googleAccessToken) {
        return {
          ok: false,
          error: 'Google Tasks access token unavailable.',
          auditSummary: 'Create Google Task failed (missing token)'
        };
      }
      const payload: Record<string, unknown> = {
        title: String(args.title)
      };
      if (args.notes) payload.notes = String(args.notes);
      if (args.dueIso) payload.due = String(args.dueIso);

      const res = await fetch('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.googleAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return {
          ok: false,
          error: `Google Tasks API HTTP ${res.status}: ${errText.slice(0, 140)}`,
          auditSummary: 'Failed to create Google Task'
        };
      }

      const created = (await res.json()) as { id?: string; title?: string; status?: string };
      return {
        ok: true,
        data: {
          taskId: created.id,
          title: created.title,
          status: created.status || 'needsAction'
        },
        auditSummary: `Created Google Task "${(created.title || String(args.title)).slice(0, 40)}"`
      };
    }
  },
  {
    name: 'gmail_search',
    connector: 'gmail',
    description: 'Searches the user Gmail messages and returns up to 20 matching message summaries (id, threadId, from, subject, date, snippet).',
    risk: 'read',
    requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    zodSchema: z.object({
      query: z.string().max(250).optional(),
      maxResults: z.number().int().min(1).max(20).optional()
    }),
    declaration: {
      name: 'gmail_search',
      description: 'Search Gmail messages using a Gmail search query (e.g., "is:unread", "from:boss", or "" for latest emails). Maximum 20 messages per call.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'Gmail search query string (leave empty for recent inbox emails).'
          },
          maxResults: {
            type: Type.NUMBER,
            description: 'Maximum emails to return (1 to 20, default 5).'
          }
        }
      }
    },
    summarizeArgs: (args) => `query="${String(args.query || 'all')}", max=${Number(args.maxResults || 5)}`,
    execute: async (args, ctx) => {
      if (!ctx.googleAccessToken) {
        return {
          ok: false,
          error: 'Gmail is not connected or access token has expired. Please connect Gmail in Connections.',
          auditSummary: 'Gmail search failed (missing token)'
        };
      }
      const maxResults = Math.min(20, Math.max(1, Number(args.maxResults || 5)));
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      const params = new URLSearchParams({ maxResults: String(maxResults) });
      if (q) params.set('q', q);

      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${ctx.googleAccessToken}` }
        }
      );

      if (!listRes.ok) {
        return {
          ok: false,
          error: `Gmail API returned HTTP ${listRes.status}. Please reconnect Gmail if your session expired.`,
          auditSummary: `Gmail search HTTP ${listRes.status}`
        };
      }

      const listData = (await listRes.json()) as {
        messages?: Array<{ id: string; threadId: string }>;
      };

      const rawMessages = (listData.messages || []).slice(0, maxResults);
      const summaries = await Promise.all(
        rawMessages.map(async (item) => {
          const detailRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            {
              headers: { Authorization: `Bearer ${ctx.googleAccessToken}` }
            }
          );
          if (!detailRes.ok) {
            return { id: item.id, threadId: item.threadId, subject: '(Metadata unavailable)' };
          }
          const detail = (await detailRes.json()) as {
            id: string;
            threadId: string;
            snippet?: string;
            payload?: { headers?: Array<{ name?: string; value?: string }> };
          };
          const headers = detail.payload?.headers;
          return {
            id: detail.id,
            threadId: detail.threadId,
            from: getHeader(headers, 'From'),
            subject: getHeader(headers, 'Subject'),
            date: getHeader(headers, 'Date'),
            snippet: stripHtmlAndTrim(detail.snippet || '', 280)
          };
        })
      );

      return {
        ok: true,
        data: {
          count: summaries.length,
          messages: summaries
        },
        auditSummary: `Searched Gmail (returned ${summaries.length} message headers)`,
        sensitiveDataRead: true
      };
    }
  },
  {
    name: 'gmail_read_message',
    connector: 'gmail',
    description: 'Reads a single Gmail message by ID and returns essential headers and a trimmed plain-text body.',
    risk: 'read',
    requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    zodSchema: z.object({
      messageId: z.string().min(1).max(128)
    }),
    declaration: {
      name: 'gmail_read_message',
      description: 'Read a specific Gmail message by its messageId. Body is automatically sanitized and trimmed.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          messageId: {
            type: Type.STRING,
            description: 'The Gmail message ID returned from gmail_search.'
          }
        },
        required: ['messageId']
      }
    },
    summarizeArgs: (args) => `messageId=${String(args.messageId || '')}`,
    execute: async (args, ctx) => {
      if (!ctx.googleAccessToken) {
        return {
          ok: false,
          error: 'Gmail is not connected. Please connect Gmail first.',
          auditSummary: 'Gmail read failed (missing token)'
        };
      }
      const messageId = String(args.messageId);
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
        {
          headers: { Authorization: `Bearer ${ctx.googleAccessToken}` }
        }
      );

      if (!res.ok) {
        return {
          ok: false,
          error: `Gmail API returned HTTP ${res.status} when reading message.`,
          auditSummary: `Gmail read HTTP ${res.status}`
        };
      }

      const data = (await res.json()) as {
        id: string;
        threadId: string;
        snippet?: string;
        payload?: Record<string, unknown> & {
          headers?: Array<{ name?: string; value?: string }>;
        };
      };

      const headers = data.payload?.headers;
      const bodyExcerpt = extractGmailBody(data.payload) || stripHtmlAndTrim(data.snippet || '', 1500);

      return {
        ok: true,
        data: {
          id: data.id,
          threadId: data.threadId,
          from: getHeader(headers, 'From'),
          to: getHeader(headers, 'To'),
          subject: getHeader(headers, 'Subject'),
          date: getHeader(headers, 'Date'),
          bodyExcerpt
        },
        auditSummary: `Read Gmail message metadata (${data.id.slice(0, 12)})`,
        sensitiveDataRead: true
      };
    }
  },
  {
    name: 'gmail_create_draft',
    connector: 'gmail',
    description: 'Creates a draft email in the user Gmail mailbox. Requires explicit user confirmation via confirm card.',
    risk: 'write',
    requiredScopes: ['https://www.googleapis.com/auth/gmail.compose'],
    zodSchema: z.object({
      to: z.string().email().max(254),
      subject: z.string().min(1).max(300),
      body: z.string().min(1).max(6000)
    }),
    declaration: {
      name: 'gmail_create_draft',
      description: 'Create a Gmail draft email. Execution pauses for user confirmation.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          to: {
            type: Type.STRING,
            description: 'Recipient email address.'
          },
          subject: {
            type: Type.STRING,
            description: 'Email subject line.'
          },
          body: {
            type: Type.STRING,
            description: 'Plain-text body of the draft.'
          }
        },
        required: ['to', 'subject', 'body']
      }
    },
    summarizeArgs: (args) => `to=${String(args.to || '')}, subject="${String(args.subject || '').slice(0, 40)}"`,
    execute: async (args, ctx) => {
      if (!ctx.googleAccessToken) {
        return {
          ok: false,
          error: 'Gmail access token unavailable. Please reconnect Gmail.',
          auditSummary: 'Draft creation failed (missing token)'
        };
      }
      const to = String(args.to).replace(/[\r\n]+/g, ' ').trim();
      const subject = String(args.subject).replace(/[\r\n]+/g, ' ').trim();
      const body = String(args.body);

      const rfc2822 = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'MIME-Version: 1.0',
        '',
        body
      ].join('\r\n');

      const raw = encodeBase64Url(rfc2822);
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.googleAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: { raw }
        })
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return {
          ok: false,
          error: `Gmail draft API HTTP ${res.status}: ${errText.slice(0, 140)}`,
          auditSummary: `Failed Gmail draft to ${to}`
        };
      }

      const created = (await res.json()) as { id?: string; message?: { id?: string } };
      return {
        ok: true,
        data: {
          draftId: created.id,
          messageId: created.message?.id,
          to,
          subject,
          status: 'draft_created'
        },
        auditSummary: `Created Gmail draft to ${to} (draftId: ${created.id || 'ok'})`
      };
    }
  },
  {
    name: 'gmail_send_email',
    connector: 'gmail',
    description: 'Sends an email immediately on behalf of the user. High-risk destructive action requiring hard user confirmation.',
    risk: 'destructive',
    requiredScopes: ['https://www.googleapis.com/auth/gmail.compose'],
    zodSchema: z.object({
      to: z.string().email().max(254),
      subject: z.string().min(1).max(300),
      body: z.string().min(1).max(6000)
    }),
    declaration: {
      name: 'gmail_send_email',
      description: 'Send a live email immediately. Requires strict user confirmation card.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          to: {
            type: Type.STRING,
            description: 'Recipient email address.'
          },
          subject: {
            type: Type.STRING,
            description: 'Subject line.'
          },
          body: {
            type: Type.STRING,
            description: 'Plain-text email body.'
          }
        },
        required: ['to', 'subject', 'body']
      }
    },
    summarizeArgs: (args) => `to=${String(args.to || '')}, subject="${String(args.subject || '').slice(0, 40)}"`,
    execute: async (args, ctx) => {
      if (!ctx.googleAccessToken) {
        return {
          ok: false,
          error: 'Gmail access token unavailable. Please reconnect Gmail.',
          auditSummary: 'Send email failed (missing token)'
        };
      }
      const to = String(args.to).replace(/[\r\n]+/g, ' ').trim();
      const subject = String(args.subject).replace(/[\r\n]+/g, ' ').trim();
      const body = String(args.body);

      const rfc2822 = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'MIME-Version: 1.0',
        '',
        body
      ].join('\r\n');

      const raw = encodeBase64Url(rfc2822);
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.googleAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ raw })
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return {
          ok: false,
          error: `Gmail send API HTTP ${res.status}: ${errText.slice(0, 140)}`,
          auditSummary: `Failed sending email to ${to}`
        };
      }

      const sent = (await res.json()) as { id?: string; threadId?: string };
      return {
        ok: true,
        data: {
          messageId: sent.id,
          threadId: sent.threadId,
          to,
          subject,
          status: 'sent'
        },
        auditSummary: `Sent email to ${to} (messageId: ${sent.id || 'ok'})`
      };
    }
  },
  {
    name: 'calendar_list_events',
    connector: 'calendar',
    description: 'Lists upcoming events from the user primary Google Calendar.',
    risk: 'read',
    requiredScopes: ['https://www.googleapis.com/auth/calendar.events'],
    zodSchema: z.object({
      maxResults: z.number().int().min(1).max(20).optional(),
      timeMinIso: z.string().max(64).optional()
    }),
    declaration: {
      name: 'calendar_list_events',
      description: 'List upcoming events on the primary Google Calendar.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          maxResults: {
            type: Type.NUMBER,
            description: 'Maximum number of events to return (1 to 20, default 10).'
          },
          timeMinIso: {
            type: Type.STRING,
            description: 'Optional ISO start timestamp filter (defaults to current time).'
          }
        }
      }
    },
    summarizeArgs: (args) => `maxResults=${Number(args.maxResults || 10)}`,
    execute: async (args, ctx) => {
      if (!ctx.googleAccessToken) {
        return {
          ok: false,
          error: 'Google Calendar is not connected. Please connect Calendar in Connections.',
          auditSummary: 'Calendar list failed (missing token)'
        };
      }
      const maxResults = Math.min(20, Math.max(1, Number(args.maxResults || 10)));
      const timeMin =
        typeof args.timeMinIso === 'string' && args.timeMinIso.trim()
          ? args.timeMinIso.trim()
          : new Date().toISOString();

      const params = new URLSearchParams({
        maxResults: String(maxResults),
        timeMin,
        singleEvents: 'true',
        orderBy: 'startTime'
      });

      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${ctx.googleAccessToken}` }
        }
      );

      if (!res.ok) {
        return {
          ok: false,
          error: `Google Calendar API returned HTTP ${res.status}.`,
          auditSummary: `Calendar list HTTP ${res.status}`
        };
      }

      const data = (await res.json()) as {
        items?: Array<{
          id?: string;
          summary?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
          location?: string;
          htmlLink?: string;
        }>;
      };

      const events = (data.items || []).map((ev) => ({
        id: ev.id || '',
        summary: ev.summary || '(Untitled event)',
        start: ev.start?.dateTime || ev.start?.date || '',
        end: ev.end?.dateTime || ev.end?.date || '',
        location: ev.location || '',
        link: ev.htmlLink || ''
      }));

      return {
        ok: true,
        data: {
          count: events.length,
          events
        },
        auditSummary: `Listed ${events.length} upcoming Calendar events`,
        sensitiveDataRead: true
      };
    }
  },
  {
    name: 'calendar_create_event',
    connector: 'calendar',
    description: 'Schedules a new event on the user primary Google Calendar. Write action requiring confirmation.',
    risk: 'write',
    requiredScopes: ['https://www.googleapis.com/auth/calendar.events'],
    zodSchema: z.object({
      summary: z.string().min(1).max(240),
      startIso: z.string().min(10).max(64),
      endIso: z.string().min(10).max(64),
      description: z.string().max(2000).optional(),
      attendeeEmail: z.string().email().max(254).optional()
    }),
    declaration: {
      name: 'calendar_create_event',
      description: 'Create a new event on the user primary Google Calendar. Pauses for user confirmation.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          summary: {
            type: Type.STRING,
            description: 'Event title.'
          },
          startIso: {
            type: Type.STRING,
            description: 'Start time in ISO 8601 format (e.g. 2026-10-27T15:00:00Z).'
          },
          endIso: {
            type: Type.STRING,
            description: 'End time in ISO 8601 format (e.g. 2026-10-27T16:00:00Z).'
          },
          description: {
            type: Type.STRING,
            description: 'Optional event notes or agenda.'
          },
          attendeeEmail: {
            type: Type.STRING,
            description: 'Optional attendee email address.'
          }
        },
        required: ['summary', 'startIso', 'endIso']
      }
    },
    summarizeArgs: (args) => `summary="${String(args.summary || '').slice(0, 40)}", start=${String(args.startIso || '')}`,
    execute: async (args, ctx) => {
      if (!ctx.googleAccessToken) {
        return {
          ok: false,
          error: 'Google Calendar access token unavailable.',
          auditSummary: 'Create calendar event failed (missing token)'
        };
      }
      const payload: Record<string, unknown> = {
        summary: String(args.summary),
        description: args.description ? String(args.description) : undefined,
        start: { dateTime: String(args.startIso) },
        end: { dateTime: String(args.endIso) }
      };
      if (args.attendeeEmail) {
        payload.attendees = [{ email: String(args.attendeeEmail) }];
      }

      const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.googleAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return {
          ok: false,
          error: `Calendar API HTTP ${res.status}: ${errText.slice(0, 140)}`,
          auditSummary: 'Calendar event creation failed'
        };
      }

      const created = (await res.json()) as { id?: string; htmlLink?: string; summary?: string };
      return {
        ok: true,
        data: {
          eventId: created.id,
          summary: created.summary,
          link: created.htmlLink,
          status: 'event_created'
        },
        auditSummary: `Created Calendar event "${created.summary || args.summary}"`
      };
    }
  },
  {
    name: 'drive_search_files',
    connector: 'drive',
    description: 'Searches files in the user Google Drive and returns essential metadata (id, name, mimeType, modifiedTime, webViewLink).',
    risk: 'read',
    requiredScopes: ['https://www.googleapis.com/auth/drive.readonly'],
    zodSchema: z.object({
      nameQuery: z.string().max(160).optional(),
      pageSize: z.number().int().min(1).max(20).optional()
    }),
    declaration: {
      name: 'drive_search_files',
      description: 'Search files in Google Drive by file name keyword (returns up to 20 files).',
      parameters: {
        type: Type.OBJECT,
        properties: {
          nameQuery: {
            type: Type.STRING,
            description: 'Optional keyword to match in file names.'
          },
          pageSize: {
            type: Type.NUMBER,
            description: 'Maximum files to return (1 to 20, default 10).'
          }
        }
      }
    },
    summarizeArgs: (args) => `nameQuery="${String(args.nameQuery || '*')}", max=${Number(args.pageSize || 10)}`,
    execute: async (args, ctx) => {
      if (!ctx.googleAccessToken) {
        return {
          ok: false,
          error: 'Google Drive is not connected. Please connect Drive in Connections.',
          auditSummary: 'Drive search failed (missing token)'
        };
      }
      const pageSize = Math.min(20, Math.max(1, Number(args.pageSize || 10)));
      const keyword = typeof args.nameQuery === 'string' ? args.nameQuery.trim().replace(/'/g, '') : '';
      const q = keyword ? `trashed = false and name contains '${keyword}'` : 'trashed = false';

      const params = new URLSearchParams({
        pageSize: String(pageSize),
        q,
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink)'
      });

      const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
        headers: { Authorization: `Bearer ${ctx.googleAccessToken}` }
      });

      if (!res.ok) {
        return {
          ok: false,
          error: `Google Drive API returned HTTP ${res.status}.`,
          auditSummary: `Drive search HTTP ${res.status}`
        };
      }

      const data = (await res.json()) as {
        files?: Array<{
          id?: string;
          name?: string;
          mimeType?: string;
          modifiedTime?: string;
          webViewLink?: string;
        }>;
      };

      const files = (data.files || []).map((f) => ({
        id: f.id || '',
        name: f.name || '',
        mimeType: f.mimeType || '',
        modifiedTime: f.modifiedTime || '',
        webViewLink: f.webViewLink || ''
      }));

      return {
        ok: true,
        data: {
          count: files.length,
          files
        },
        auditSummary: `Searched Google Drive (found ${files.length} files)`,
        sensitiveDataRead: true
      };
    }
  }
];

export function getToolsForConnectedProviders(connectedProviders: ConnectorId[]): AgentTool[] {
  const allowedSet = new Set<ConnectorId>(['system', ...connectedProviders]);
  return ALL_TOOLS.filter((tool) => allowedSet.has(tool.connector));
}

export function getToolByName(name: string): AgentTool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}
