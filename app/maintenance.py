"""A small reader/writer barrier for exclusive database restoration."""
import threading


class MaintenanceBarrier:
    def __init__(self):
        self._condition = threading.Condition()
        self._active = 0
        self._exclusive = False

    def enter(self, exclusive: bool) -> None:
        with self._condition:
            if exclusive:
                while self._exclusive or self._active:
                    self._condition.wait()
                self._exclusive = True
            else:
                while self._exclusive:
                    self._condition.wait()
                self._active += 1

    def leave(self, exclusive: bool) -> None:
        with self._condition:
            if exclusive:
                self._exclusive = False
            else:
                self._active -= 1
            self._condition.notify_all()
