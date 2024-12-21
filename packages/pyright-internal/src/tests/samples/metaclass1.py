# This sample tests pyright's ability to use metaclasses.

from ctypes import Array, c_uint64
from typing import Any, TypeAlias, TypeVar

myArray1 = (c_uint64 * 5)()

myArray2: Array[c_uint64] = (c_uint64 * 5)()


T = TypeVar("T")


class CustomMeta(type):
    def __getitem__(self, key: Any) -> "type[int]":
        ...


class Custom(metaclass=CustomMeta):
    ...


# This should generate an error because the class isn't
# Generic even though it supports a metaclass with a
# __getitem__.
y1: Custom[int]

# This should not generate an error because it is used
# as a runtime expression rather than a type annotation.
y2 = Custom[int]

# This should generate an error.
y3: TypeAlias = Custom[int]
