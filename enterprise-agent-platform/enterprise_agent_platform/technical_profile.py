from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .technical_profile_generated import TECHNICAL_PROFILES


@dataclass(frozen=True)
class TechnicalProfile:
    """Closed-world Platform machine identity.

    These values are protocol identity, not administrator branding.  Callers
    receive one of the two module-owned instances below; arbitrary environment
    values never become paths, marker names, cookies, or health identities.
    """

    profile_id: str
    selector_environment_variable: str
    deployment_mode_environment_variable: str
    manager_socket_environment_variable: str
    manager_token_file_environment_variable: str
    host_data_root_environment_variable: str
    manager_environment_prefix: str
    platform_environment_prefix: str
    default_data_root: Path | None
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

    @property
    def is_target(self) -> bool:
        return self.profile_id == TECHNICAL_PROFILES["target"]["profile_id"]

    def environment_variable(
        self,
        source_name: str,
        *,
        target_name: str | None = None,
    ) -> str:
        if not self.is_target:
            return source_name
        if target_name:
            return target_name
        prefix_pairs = (
            (
                SOURCE_TECHNICAL_PROFILE.platform_environment_prefix,
                TARGET_TECHNICAL_PROFILE.platform_environment_prefix,
            ),
            (
                SOURCE_TECHNICAL_PROFILE.manager_environment_prefix,
                TARGET_TECHNICAL_PROFILE.manager_environment_prefix,
            ),
        )
        for source_prefix, target_prefix in prefix_pairs:
            source_marker = source_prefix + "_"
            if source_name.startswith(source_marker):
                return target_prefix + "_" + source_name.removeprefix(source_marker)
        raise ValueError(f"no target environment mapping for {source_name}")


def _build_technical_profile(role: str) -> TechnicalProfile:
    values = dict(TECHNICAL_PROFILES[role])
    for name in (
        "default_data_root",
        "default_manager_socket",
        "default_manager_token_file",
    ):
        if values[name] is not None:
            values[name] = Path(str(values[name]))
    return TechnicalProfile(**values)  # type: ignore[arg-type]


SOURCE_TECHNICAL_PROFILE = _build_technical_profile("source")
TARGET_TECHNICAL_PROFILE = _build_technical_profile("target")

SOURCE_DATABASE_BASELINE = SOURCE_TECHNICAL_PROFILE.database_baseline_name
TARGET_DATABASE_BASELINE = TARGET_TECHNICAL_PROFILE.database_baseline_name

_PROFILES = {
    SOURCE_TECHNICAL_PROFILE.profile_id: SOURCE_TECHNICAL_PROFILE,
    TARGET_TECHNICAL_PROFILE.profile_id: TARGET_TECHNICAL_PROFILE,
}


def technical_profile(profile: TechnicalProfile | str | None) -> TechnicalProfile:
    if profile is None:
        return SOURCE_TECHNICAL_PROFILE
    if isinstance(profile, TechnicalProfile):
        canonical = _PROFILES.get(profile.profile_id)
        if canonical == profile:
            return canonical
        raise ValueError("technical profile is not a canonical closed-world value")
    canonical = _PROFILES.get(str(profile))
    if canonical is None:
        raise ValueError(f"unknown technical profile: {profile!r}")
    return canonical


def select_technical_profile(
    environment: Mapping[str, str] | None = None,
) -> TechnicalProfile:
    """Select one exact profile and reject mixed namespace input.

    Source remains the default for the already-deployed baseline.  Target is
    never inferred from one convenient target variable: its exact selector is
    mandatory, and source variables are forbidden in the same process.
    """

    values = os.environ if environment is None else environment
    source_selector = str(
        values.get(SOURCE_TECHNICAL_PROFILE.selector_environment_variable, "")
        or ""
    ).strip()
    target_selector = str(
        values.get(TARGET_TECHNICAL_PROFILE.selector_environment_variable, "")
        or ""
    ).strip()
    source_keys = sorted(
        key
        for key in values
        if any(
            key.startswith(prefix + "_")
            for prefix in {
                SOURCE_TECHNICAL_PROFILE.manager_environment_prefix,
                SOURCE_TECHNICAL_PROFILE.platform_environment_prefix,
            }
        )
    )
    target_keys = sorted(
        key
        for key in values
        if any(
            key.startswith(prefix + "_")
            for prefix in {
                TARGET_TECHNICAL_PROFILE.manager_environment_prefix,
                TARGET_TECHNICAL_PROFILE.platform_environment_prefix,
            }
        )
    )

    if source_selector and source_selector != SOURCE_TECHNICAL_PROFILE.profile_id:
        raise ValueError(f"unknown technical profile: {source_selector!r}")
    if target_selector and target_selector != TARGET_TECHNICAL_PROFILE.profile_id:
        raise ValueError(f"unknown technical profile: {target_selector!r}")
    if source_selector and target_selector:
        raise ValueError("source and target technical profiles cannot be mixed")

    if target_selector:
        if source_keys:
            raise ValueError("source and target Platform environment variables cannot be mixed")
        return TARGET_TECHNICAL_PROFILE

    if target_keys:
        raise ValueError(
            f"{TARGET_TECHNICAL_PROFILE.selector_environment_variable}="
            f"{TARGET_TECHNICAL_PROFILE.profile_id} is required "
            "for target Platform environment variables"
        )
    return SOURCE_TECHNICAL_PROFILE


def other_technical_profile(profile: TechnicalProfile | str) -> TechnicalProfile:
    selected = technical_profile(profile)
    return (
        SOURCE_TECHNICAL_PROFILE
        if selected.is_target
        else TARGET_TECHNICAL_PROFILE
    )
