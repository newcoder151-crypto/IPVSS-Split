"""Analyzer registry. Add a new analytic = write a class, register it here,
and add its allowed event types to backend/api/src/routes/analytics.js."""
from analyzers.crowd import CrowdAnalyzer
from analyzers.fake import FakeAnalyzer
from analyzers.fall_lean import FallLeanAnalyzer
from analyzers.rail_obstacle import RailObstacleAnalyzer
from analyzers.smoke import SmokeAnalyzer

REGISTRY = {
    FakeAnalyzer.name: FakeAnalyzer,
    FallLeanAnalyzer.name: FallLeanAnalyzer,
    CrowdAnalyzer.name: CrowdAnalyzer,
    SmokeAnalyzer.name: SmokeAnalyzer,
    RailObstacleAnalyzer.name: RailObstacleAnalyzer,
}
