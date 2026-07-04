from fastapi import APIRouter, Depends

from app.security import authenticated_user, quota_status

router = APIRouter()


@router.get("/quota")
def get_quota(user: dict = Depends(authenticated_user)) -> dict:
    return {
        "user": {
            "githubId": user["userId"],
            "githubLogin": user["userLogin"],
        },
        "limits": quota_status(user["userId"], user["ip"]),
    }
