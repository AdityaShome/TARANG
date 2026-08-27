from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from google import genai
import os

router = APIRouter(prefix="/copilot", tags=["AI Copilot"])


class CopilotRequest(BaseModel):
    query: str


class CopilotResponse(BaseModel):
    answer: str


SYSTEM_PROMPT = """
You are TARANG AI Copilot, an intelligent assistant for the TARANG
3D ocean visualization platform.

TARANG visualizes oceanographic data including:

- Water temperature
- Salinity
- Ocean depth
- Time-dependent ocean data
- Argo profiling floats
- Temperature isosurfaces
- 3D ocean volumes
- Depth slices
- HYCOM / Copernicus / INCOIS ocean data

Your job is to understand natural-language questions from users.

IMPORTANT:
The user is NOT restricted to predefined questions.
Understand arbitrary natural-language questions related to ocean data,
ocean visualization, TARANG features, temperature, salinity, depth,
Argo floats, isosurfaces and ocean science.

Give concise, useful answers.

If the user asks how to perform something in TARANG, explain the action
clearly.

If the question is unrelated to ocean data, politely explain that you
are TARANG's ocean-focused AI Copilot.

Do not invent actual sensor measurements or real-time ocean values that
have not been provided to you.

You are an assistant inside the TARANG visualization system, not a
generic chatbot.
"""


@router.post("", response_model=CopilotResponse)
async def copilot(request: CopilotRequest):

    query = request.query.strip()

    if not query:
        raise HTTPException(
            status_code=400,
            detail="Query cannot be empty"
        )

    api_key = os.getenv("GEMINI_API_KEY")

    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="GEMINI_API_KEY is not configured"
        )

    try:
        client = genai.Client(api_key=api_key)

        response = await client.aio.models.generate_content(
            model="gemini-3.7-flash",
            contents=f"""
{SYSTEM_PROMPT}

USER QUESTION:
{query}
""",
        )

        answer = response.text

        return CopilotResponse(answer=answer)

    except Exception as e:
        print(f"Copilot error: {e}")

        raise HTTPException(
            status_code=500,
            detail="Unable to get a response from TARANG AI Copilot"
        )