class ExampleClass:
#     ^^^^^^^^^^^^ definition  src/single_class unknown ExampleClass#
    a: int
#   ^ definition  src/single_class unknown ExampleClass#a.
#      ^^^ reference  builtins 3.9 int#
    b: int
#   ^ definition  src/single_class unknown ExampleClass#b.
#      ^^^ reference  builtins 3.9 int#
    c: str
#   ^ definition  src/single_class unknown ExampleClass#c.
#      ^^^ reference  builtins 3.9 str#

    static_var = "Hello World"
#   ^^^^^^^^^^ definition  src/single_class unknown ExampleClass#static_var.

    def __init__(self, a: int, b: int):
#       ^^^^^^^^ definition  src/single_class unknown ExampleClass#__init__().
#                ^^^^ definition  src/single_class unknown ExampleClass#__init__().(self)
#                      ^ definition  src/single_class unknown ExampleClass#__init__().(a)
#                         ^^^ reference  builtins 3.9 int#
#                              ^ definition  src/single_class unknown ExampleClass#__init__().(b)
#                                 ^^^ reference  builtins 3.9 int#
        local_c = ", world!"
#       ^^^^^^^ definition  src/single_class unknown ExampleClass#__init__().local_c.

        self.a = a
#       ^^^^ reference  src/single_class unknown ExampleClass#__init__().(self)
#            ^ reference  src/single_class unknown ExampleClass#a.
#                ^ reference  src/single_class unknown ExampleClass#__init__().(a)
        self.b = b
#       ^^^^ reference  src/single_class unknown ExampleClass#__init__().(self)
#            ^ reference  src/single_class unknown ExampleClass#b.
#                ^ reference  src/single_class unknown ExampleClass#__init__().(b)
        self.c = "hello" + local_c
#       ^^^^ reference  src/single_class unknown ExampleClass#__init__().(self)
#            ^ reference  src/single_class unknown ExampleClass#c.
#                          ^^^^^^^ reference  src/single_class unknown ExampleClass#__init__().local_c.

