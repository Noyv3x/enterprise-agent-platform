from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .technical_profile_generated import TECHNICAL_PROFILES


@dataclass(frozen=True)
class TechnicalProfile:
    """Closed-world machine identity for the only supported baseline."""

    profile_id: str
    selector_environment_variable: str
    deployment_mode_environment_variable: str
    manager_socket_environment_variable: str
    manager_token_file_environment_variable: str
    host_data_root_environment_variable: str
    manager_environment_prefix: str
    platform_environment_prefix: str
    default_data_root: Path
    default_manager_socket: Path
    default_manager_token_file: Path
    database_baseline_name: str
    instance_lock_name: str
    scope_marker_name: str
    camofox_sidecar_name: str
    workspace_internal_directory: str
    session_namespace: str
    session_cookie_name: str
    health_service: str
    search_health_service: str
    agent_runtime_health_service: str


def _build_technical_profile() -> TechnicalProfile:
    values = dict(TECHNICAL_PROFILES["target"])
    for name in (
        "default_data_root",
        "default_manager_socket",
        "default_manager_token_file",
    ):
        values[name] = Path(str(values[name]))
    return TechnicalProfile(**values)  # type: ignore[arg-type]


TARGET_TECHNICAL_PROFILE = _build_technical_profile()
TARGET_DATABASE_BASELINE = TARGET_TECHNICAL_PROFILE.database_baseline_name


def technical_profile(profile: TechnicalProfile | str | None = None) -> TechnicalProfile:
    if profile is None:
        return TARGET_TECHNICAL_PROFILE
    if isinstance(profile, TechnicalProfile):
        if profile == TARGET_TECHNICAL_PROFILE:
            return TARGET_TECHNICAL_PROFILE
        raise ValueError("technical profile is not the canonical target value")
    if str(profile) != TARGET_TECHNICAL_PROFILE.profile_id:
        raise ValueError(f"unknown technical profile: {profile!r}")
    return TARGET_TECHNICAL_PROFILE


def select_technical_profile(
    environment: Mapping[str, str] | None = None,
) -> TechnicalProfile:
    """Select the sole supported technical profile.

    The selector may be omitted for local library use. When present it must
    identify the current baseline exactly; arbitrary values never become paths,
    cookies, marker names, or health identities.
    """

    values = os.environ if environment is None else environment
    selector = str(
        values.get(TARGET_TECHNICAL_PROFILE.selector_environment_variable, "")
        or ""
    ).strip()
    if selector and selector != TARGET_TECHNICAL_PROFILE.profile_id:
        raise ValueError(f"unknown technical profile: {selector!r}")
    return TARGET_TECHNICAL_PROFILE
