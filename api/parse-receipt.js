// api/parse-receipt.js

import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, 
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { receiptText } = req.body;

  if (!receiptText) {
    return res.status(400).json({ error: 'Missing receipt text' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", 
      messages: [
        {
          role: "system",
          content: "You are a specialized assistant that extracts and formats grocery item data from receipt text. For each item, return the name, total price, quantity, and unit. If a field is not found, use null. Your response MUST be a JSON array. DO NOT include any other text."
        },
        {
          role: "user",
          content: `Extract the items from this receipt:\n\n${receiptText}`
        }
      ],
      response_format: { type: "json_object" }
    });

    const parsedData = JSON.parse(completion.choices[0].message.content);
    res.status(200).json({ items: parsedData.items });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Failed to parse receipt.' });
  }
}
