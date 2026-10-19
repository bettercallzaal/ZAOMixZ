// AgentPost.js — an approved agent draft, labelled as AI wherever the audience sees it
// (agent gateway, gate 4).
//
// docs/STREAM-EVENTS.md, Phase 5: anything published from an agent stays labelled where the
// audience sees it. When the DJ approves a draft in the AGENT DRAFTS panel (AgentQueue.js), the
// desk sends one agent.post stream event (only while ON AIR, like every event) and the OBS
// overlay shows it as a card under the label below. The label is the overlay's own text, not
// something carried in the event, so no agent and no edit can take it off or reword it.
//
// Pure apart from the card, which takes a document: see AgentPost.test.mjs.

export const AI_LABEL = 'AI SUGGESTION, APPROVED BY THE HOST';
export const POST_SHOW_MS = 12000;

// agent.post data from the receipt of an approval. Only what the DJ approved is published:
// the edited text when the DJ changed it.
export function agentPostData(receipt) {
    if (!receipt || (receipt.outcome !== 'approved' && receipt.outcome !== 'edited')) return null;
    const text = String(receipt.published || '').slice(0, 280);
    if (!text) return null;
    return { agent: String(receipt.agent || 'Agent').slice(0, 24), kind: receipt.kind === 'question' ? 'question' : 'comment', text, edited: receipt.outcome === 'edited', ai: true };
}

// The overlay's card for one post. Text only: nothing in the event becomes markup.
export function showAgentPost(doc, data, { hideAfter = POST_SHOW_MS, setTimer = setTimeout } = {}) {
    if (!doc || !data || typeof data.text !== 'string' || !data.text) return null;
    let card = doc.getElementById('agent-post');
    if (!card) {
        card = doc.createElement('div');
        card.id = 'agent-post';
        card.className = 'agent-post';
        doc.body.appendChild(card);
    }
    card.textContent = '';
    const label = doc.createElement('div');
    label.className = 'agent-post-label';
    label.textContent = AI_LABEL;
    const who = doc.createElement('div');
    who.className = 'agent-post-who';
    who.textContent = `${data.kind === 'question' ? 'Question' : 'Comment'} from ${String(data.agent || 'Agent').slice(0, 24)}`;
    const text = doc.createElement('div');
    text.className = 'agent-post-text';
    text.textContent = data.text.slice(0, 280);
    card.appendChild(label); card.appendChild(who); card.appendChild(text);
    card.classList?.add('visible');
    const shown = (card._shown = (card._shown || 0) + 1);
    setTimer(() => { if (card._shown === shown) card.classList?.remove('visible'); }, hideAfter);
    return card;
}
